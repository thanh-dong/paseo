# Auto-Resume on Usage Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an opted-in agent session is cut short by a provider usage limit, the daemon detects the limit from **usage-window numbers** (never message text), schedules a background resume at the limit's reset time, shows "will automatically resume at {time}" in the app, and lets the user resume manually if detection is wrong.

**Architecture:** A new daemon-side `AutoResumeWatcher` observes agent turn ends and the existing `ProviderUsageService` (the "Plan usage" quota fetcher). Detection: agent idle + any usage window with `remainingPct ≤ 1` and a future `resetsAt`. The watcher persists pending state on the agent record, arms an in-process timer (re-armed from storage on boot), verifies the window actually reset before firing, then resumes the session via `agentManager.runAgent`. A per-agent toggle lives in the context-window popup; a banner with the resume time and a "Resume now" button lives in the agent panel.

**Tech Stack:** TypeScript strict, Zod schemas in `@getpaseo/protocol`, vitest, React Native (Expo) app, WebSocket RPC per `docs/rpc-namespacing.md`.

## Global Constraints

- **Never decide anything from assistant/error message text.** The Claude SDK reports limit hits as a normal assistant message inside a `subtype: "success"` result, and wording changes. All detection is numeric (usage windows) + run state. Do NOT port `usage-limit.ts` regex code from branch `feat/auto-resume-usage-limit`.
- Protocol stays backward compatible: new schema fields optional, never required; wire schemas pure (no `.transform()`/`.catch()`/`.preprocess()`). Read `docs/protocol-compatibility.md`.
- Feature-gate the client on `server_info.features.autoResumeOnLimit`; tag with `// COMPAT(autoResumeOnLimit): added in vNEXT, remove gate once daemon floor >= vNEXT.`
- New RPCs use dotted namespaces (`agent.auto_resume.set.request` / `.response`) per `docs/rpc-namespacing.md`.
- After every change: `npm run typecheck` and `npm run lint`. Before committing: `npm run format`.
- Cross-package types: if typecheck fails in a dependent package, run `npm run build:client` (protocol/client) or `npm run build:server` first — do not patch around stale declarations.
- Tests: run ONLY the specific file you changed: `npx vitest run <file> --bail=1`. Never a full workspace suite.
- Repo tooling gotcha: plain `grep`/`git` in Bash are rewritten by the rtk hook. If output looks truncated or mangled, retry as `rtk proxy git ...` / `rtk proxy grep ...`.
- Branch `feat/auto-resume-usage-limit` exists with an older regex-based attempt. Reuse only the snippets this plan explicitly copies (view with `rtk proxy git diff main...feat/auto-resume-usage-limit -- <path>`). Do NOT rebase or merge that branch; work on a new branch from `main`, e.g. `feat/auto-resume-usage-v2`.
- Working state: create the branch first; commit after every task.

---

### Task 1: Protocol — snapshot fields, RPC pair, feature flag

**Files:**

- Modify: `packages/protocol/src/messages.ts`

**Interfaces:**

- Produces: `AgentSnapshotPayloadSchema` gains optional `autoResumeOnLimit: boolean` and `autoResumeAt: number` (epoch ms). New message schemas `AgentAutoResumeSetRequestMessageSchema` (`agent.auto_resume.set.request` — `{agentId, enabled, requestId}`), `AgentAutoResumeTriggerRequestMessageSchema` (`agent.auto_resume.trigger.request` — `{agentId, requestId}`), each with a `.response` twin whose payload is `AgentActionResponsePayloadSchema` (same as `agent.detach`). Feature flag `autoResumeOnLimit?: boolean` in `ServerInfoStatusPayloadSchema.features`.

- [ ] **Step 1: Add snapshot fields**

In `messages.ts`, find `AgentSnapshotPayloadSchema` (search `lastError: z.string().optional()`, around line 760) and add directly after `lastError`:

```ts
  autoResumeOnLimit: z.boolean().optional(),
  autoResumeAt: z.number().int().nonnegative().optional(),
```

- [ ] **Step 2: Add the RPC message schemas**

Place next to `AgentDetachRequestMessageSchema` (search `agent.detach.request`, around line 1548):

```ts
export const AgentAutoResumeSetRequestMessageSchema = z.object({
  type: z.literal("agent.auto_resume.set.request"),
  agentId: z.string(),
  enabled: z.boolean(),
  requestId: z.string(),
});

export const AgentAutoResumeSetResponseMessageSchema = z.object({
  type: z.literal("agent.auto_resume.set.response"),
  payload: AgentActionResponsePayloadSchema,
});

export const AgentAutoResumeTriggerRequestMessageSchema = z.object({
  type: z.literal("agent.auto_resume.trigger.request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const AgentAutoResumeTriggerResponseMessageSchema = z.object({
  type: z.literal("agent.auto_resume.trigger.response"),
  payload: AgentActionResponsePayloadSchema,
});
```

- [ ] **Step 3: Register in every union `agent.detach` is in**

Run `rtk proxy grep -n "AgentDetachRequestMessageSchema\|AgentDetachResponseMessageSchema" packages/protocol/src/messages.ts` and add the four new schemas to the same discriminated unions / exported type maps (inbound request union, outbound response union, and any name→schema registry). Export inferred types mirroring the detach ones.

- [ ] **Step 4: Add the feature flag**

In `ServerInfoStatusPayloadSchema.features` (search `providerUsageList: z.boolean().optional()`, around line 3025), add:

```ts
        // COMPAT(autoResumeOnLimit): added in vNEXT, remove gate once daemon floor >= vNEXT.
        autoResumeOnLimit: z.boolean().optional(),
```

(Replace `vNEXT` with the current version from `packages/server/package.json` + one patch.)

- [ ] **Step 5: Build and verify**

Run: `npm run build:client && npm run typecheck`
Expected: PASS (the protocol `pretypecheck` regenerates zod-aot validators automatically; see `docs/protocol-validation.md` if generation fails).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/messages.ts
git commit -m "feat(protocol): auto-resume-on-limit snapshot fields, RPCs, feature flag"
```

---

### Task 2: Server — persist auto-resume state on the agent record

**Files:**

- Modify: `packages/server/src/server/agent/agent-storage.ts` (stored schema, ~line 69)
- Modify: `packages/server/src/server/agent/agent-manager.ts` (`ManagedAgentBase`, registerAgent/reload/rehydrate paths)
- Modify: `packages/server/src/server/agent/agent-projections.ts` (`toStoredAgentRecord`, `toAgentPayload`, `buildStoredAgentPayload`)
- Test: `packages/server/src/server/agent/agent-storage.test.ts` (extend existing round-trip coverage)

**Interfaces:**

- Produces: `ManagedAgentBase.autoResumeOnLimit: boolean` (default false) and `ManagedAgentBase.autoResume?: { at: number; attempt: number }`. Stored record carries the same two fields. Snapshot payload carries `autoResumeOnLimit` and `autoResumeAt` (from `autoResume.at`).
- Consumes: Task 1 schema fields.

- [ ] **Step 1: Extend the stored-agent schema**

In `agent-storage.ts` `STORED_AGENT_SCHEMA` after `lastError`:

```ts
  autoResumeOnLimit: z.boolean().optional(),
  autoResume: z
    .object({
      at: z.number().int().nonnegative(),
      attempt: z.number().int().positive(),
    })
    .optional(),
```

- [ ] **Step 2: Extend `ManagedAgentBase` and all construction sites**

In `agent-manager.ts` add to `ManagedAgentBase` (near `lastError?: string`, ~line 359):

```ts
  autoResumeOnLimit: boolean;
  autoResume?: { at: number; attempt: number };
```

Then fix every compile error the field creates: agent creation sets `autoResumeOnLimit: false`, the reload/replacement path (~line 1631 on the branch diff; search `lastError: preservedLastError`) preserves both fields from `existing`, and the rehydrate-from-record path (search `lastError: record.lastError ?? undefined`, ~line 1611) sets `autoResumeOnLimit: record.autoResumeOnLimit ?? false, autoResume: record.autoResume`.

- [ ] **Step 3: Project to storage and payload**

In `agent-projections.ts`:

`toStoredAgentRecord` — after `lastError`:

```ts
    autoResumeOnLimit: agent.autoResumeOnLimit || undefined,
    autoResume: agent.autoResume,
```

`toAgentPayload` — after the `lastError` block:

```ts
if (agent.autoResumeOnLimit) {
  payload.autoResumeOnLimit = true;
}
if (agent.autoResume) {
  payload.autoResumeAt = agent.autoResume.at;
}
```

`buildStoredAgentPayload` — inside the returned object:

```ts
    ...(record.autoResumeOnLimit ? { autoResumeOnLimit: true } : {}),
    ...(record.autoResume ? { autoResumeAt: record.autoResume.at } : {}),
```

- [ ] **Step 4: Write the round-trip test**

In `agent-storage.test.ts`, copy the shape of an existing upsert/get test and assert the two new fields survive persistence:

```ts
test("persists autoResumeOnLimit flag and pending autoResume state", async () => {
  // build a valid record the way neighboring tests do, plus:
  //   autoResumeOnLimit: true,
  //   autoResume: { at: 1_800_000_000_000, attempt: 1 },
  // upsert, then get, then:
  expect(loaded?.autoResumeOnLimit).toBe(true);
  expect(loaded?.autoResume).toEqual({ at: 1_800_000_000_000, attempt: 1 });
});
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run packages/server/src/server/agent/agent-storage.test.ts --bail=1` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/agent/agent-storage.ts packages/server/src/server/agent/agent-storage.test.ts packages/server/src/server/agent/agent-manager.ts packages/server/src/server/agent/agent-projections.ts
git commit -m "feat(server): persist per-agent auto-resume flag and pending state"
```

---

### Task 3: Server — AgentManager hooks (turn-end callback, setters, cancellation)

**Files:**

- Modify: `packages/server/src/server/agent/agent-manager.ts`
- Test: `packages/server/src/server/agent/agent-manager.test.ts` (only if an existing lightweight pattern fits; the watcher tests in Task 4 are the primary coverage)

**Interfaces:**

- Produces (all on `AgentManager`):
  - option + setter `onAgentTurnEnded?: (params: { agentId: string; provider: AgentProvider }) => void`
  - `setAutoResumeEnabled(agentId: string, enabled: boolean): Promise<void>` — persists flag; when disabling also clears pending state.
  - `setPendingAutoResume(agentId: string, state: { at: number; attempt: number } | null): Promise<void>` — persists + emits snapshot so clients see `autoResumeAt` appear/disappear.
  - `getAutoResumeView(agentId: string): { enabled: boolean; pending: { at: number; attempt: number } | null; provider: AgentProvider; running: boolean; archived: boolean; lastUserMessageAt: number | null } | null`
  - `listAutoResumeAgents(): string[]` — ids of live agents with the flag on.
- Consumes: Task 2 fields; existing `hasInFlightRun(agentId)`.

- [ ] **Step 1: Add the option and invoke it at turn end**

Add `onAgentTurnEnded` to `AgentManagerOptions`, store it in the constructor. Find the single central place where the manager consumes stream events and clears the active turn (`rtk proxy grep -n "turn_completed\|turn_failed" packages/server/src/server/agent/agent-manager.ts` — the switch near lines 3656–3665 that updates agent state, NOT the `runAgent` loop). After the state update for both `turn_completed` and `turn_failed`, add:

```ts
this.onAgentTurnEnded?.({ agentId: agent.id, provider: agent.provider });
```

Guard against firing for background/subagent turns only if the switch already distinguishes them; foreground turn end is the signal we need.

- [ ] **Step 2: Implement the setters and view**

```ts
  async setAutoResumeEnabled(agentId: string, enabled: boolean): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.autoResumeOnLimit = enabled;
    if (!enabled) {
      agent.autoResume = undefined;
    }
    await this.persistSnapshot(agent);
    this.emitState(agent, { persist: false });
  }

  async setPendingAutoResume(
    agentId: string,
    state: { at: number; attempt: number } | null,
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.autoResume = state ?? undefined;
    await this.persistSnapshot(agent);
    this.emitState(agent, { persist: false });
  }

  getAutoResumeView(agentId: string) {
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    return {
      enabled: agent.autoResumeOnLimit,
      pending: agent.autoResume ?? null,
      provider: agent.provider,
      running: this.hasInFlightRun(agentId),
      archived: false,
      lastUserMessageAt: agent.lastUserMessageAt?.getTime() ?? null,
    };
  }

  listAutoResumeAgents(): string[] {
    return [...this.agents.values()]
      .filter((agent) => agent.autoResumeOnLimit)
      .map((agent) => agent.id);
  }
```

Match `persistSnapshot`/`emitState`/`requireAgent` call conventions to their existing usages in the file (persistSnapshot may need the `{ internal: agent.internal }` second arg — copy a neighboring call).

- [ ] **Step 3: Cancel pending state on user prompt and archive**

In the prompt-submission path where `agent.lastError = undefined` is set for a new turn (~line 2346), add — but only for genuinely user-authored prompts (the file already computes system-envelope detection with `isSystemInjectedEnvelope`; reuse that check exactly as the old branch did):

```ts
if (agent.autoResume && !isSystemPrompt) {
  agent.autoResume = undefined;
  // persisted by the normal turn-start snapshot flow; emitState so the banner clears immediately
  this.emitState(agent, { persist: false });
}
```

In the archive path (search `clearPendingAutoResume` on the branch for the location: the method that snapshots before archiving, ~line 1780 area), clear `agent.autoResume` and `agent.autoResumeOnLimit = false` before the final snapshot.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/agent-manager.ts
git commit -m "feat(server): agent-manager hooks for auto-resume (turn-end callback, setters, cancellation)"
```

---

### Task 4: Server — `AutoResumeWatcher` (detection + timer + guards), TDD

**Files:**

- Create: `packages/server/src/server/agent/auto-resume.ts`
- Test: `packages/server/src/server/agent/auto-resume.test.ts`

**Interfaces:**

- Consumes: `ProviderUsageService.listUsage({ forceRefresh })` (`packages/server/src/services/quota-fetcher/service.ts`), `ProviderUsage` from `../messages.js`, Task 3 manager methods, `AgentStorage.list()` for boot restore.
- Produces:
  - `selectAutoResumeAt(usage: ProviderUsage | undefined, nowMs: number): number | null` (pure)
  - `class AutoResumeWatcher` with `start()`, `stop()`, `setEnabled(agentId, enabled)`, `triggerNow(agentId)`, `onTurnEnded(agentId)`.
  - `AUTO_RESUME_PROMPT` constant (exported for tests).

- [ ] **Step 1: Write failing tests for the pure decision function**

```ts
import { describe, expect, test } from "vitest";
import { selectAutoResumeAt, AUTO_RESUME_BUFFER_MS } from "./auto-resume.js";
import type { ProviderUsage } from "../messages.js";

const NOW = Date.parse("2026-08-11T00:00:00Z");

function usage(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "ok",
    planLabel: "Max 5x",
    windows,
    balances: [],
    details: [],
    error: null,
  };
}

function win(over: Partial<ProviderUsage["windows"][number]>): ProviderUsage["windows"][number] {
  return {
    id: "five_hour",
    label: "Session",
    usedPct: 50,
    remainingPct: 50,
    resetsAt: null,
    ...over,
  };
}

describe("selectAutoResumeAt", () => {
  test("returns null when no window is exhausted", () => {
    expect(selectAutoResumeAt(usage([win({})]), NOW)).toBeNull();
  });

  test("returns reset + buffer for a single exhausted window", () => {
    const resetsAt = "2026-08-11T03:00:00Z";
    const result = selectAutoResumeAt(
      usage([win({ usedPct: 100, remainingPct: 0, resetsAt })]),
      NOW,
    );
    expect(result).toBe(Date.parse(resetsAt) + AUTO_RESUME_BUFFER_MS);
  });

  test("uses the LATEST reset when several windows are exhausted", () => {
    const result = selectAutoResumeAt(
      usage([
        win({ id: "five_hour", usedPct: 100, remainingPct: 0, resetsAt: "2026-08-11T03:00:00Z" }),
        win({
          id: "weekly",
          label: "Weekly",
          usedPct: 99.5,
          remainingPct: 0.5,
          resetsAt: "2026-08-15T00:00:00Z",
        }),
      ]),
      NOW,
    );
    expect(result).toBe(Date.parse("2026-08-15T00:00:00Z") + AUTO_RESUME_BUFFER_MS);
  });

  test("derives remaining from usedPct when remainingPct is null", () => {
    const result = selectAutoResumeAt(
      usage([win({ usedPct: 99.5, remainingPct: null, resetsAt: "2026-08-11T03:00:00Z" })]),
      NOW,
    );
    expect(result).not.toBeNull();
  });

  test("ignores exhausted windows with past or missing resetsAt", () => {
    expect(
      selectAutoResumeAt(
        usage([
          win({ usedPct: 100, remainingPct: 0, resetsAt: "2026-08-10T00:00:00Z" }),
          win({ id: "weekly", usedPct: 100, remainingPct: 0, resetsAt: null }),
        ]),
        NOW,
      ),
    ).toBeNull();
  });

  test("returns null for unavailable provider usage", () => {
    expect(selectAutoResumeAt({ ...usage([]), status: "unavailable" }, NOW)).toBeNull();
    expect(selectAutoResumeAt(undefined, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/src/server/agent/auto-resume.test.ts --bail=1`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

```ts
import type { Logger } from "pino";
import type { ProviderUsage } from "../messages.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export const AUTO_RESUME_BUFFER_MS = 2 * 60_000;
export const AUTO_RESUME_MAX_ATTEMPTS = 3;
export const AUTO_RESUME_HEARTBEAT_MS = 5 * 60_000;
const EXHAUSTED_REMAINING_PCT = 1;
const MIN_FORCED_FETCH_INTERVAL_MS = 60_000;

export const AUTO_RESUME_PROMPT = [
  "A provider usage limit interrupted this session and has since reset.",
  "If the task from the previous messages is unfinished, continue it from where it stopped.",
  "If it was already complete, reply with a one-line confirmation and stop.",
].join(" ");

export function selectAutoResumeAt(usage: ProviderUsage | undefined, nowMs: number): number | null {
  if (!usage || usage.status !== "ok") return null;
  let latestReset: number | null = null;
  for (const window of usage.windows) {
    const remaining =
      window.remainingPct ?? (typeof window.usedPct === "number" ? 100 - window.usedPct : null);
    if (remaining === null || remaining > EXHAUSTED_REMAINING_PCT) continue;
    if (!window.resetsAt) continue;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    latestReset = latestReset === null ? resetMs : Math.max(latestReset, resetMs);
  }
  return latestReset === null ? null : latestReset + AUTO_RESUME_BUFFER_MS;
}

export interface AutoResumeWatcherOptions {
  agentManager: AgentManager;
  providerUsageService: ProviderUsageService;
  agentStorage: AgentStorage;
  logger: Logger;
  now?: () => number;
}

export class AutoResumeWatcher {
  private readonly manager: AgentManager;
  private readonly usageService: ProviderUsageService;
  private readonly storage: AgentStorage;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastForcedFetchMs = 0;

  constructor(options: AutoResumeWatcherOptions) {
    this.manager = options.agentManager;
    this.usageService = options.providerUsageService;
    this.storage = options.agentStorage;
    this.logger = options.logger.child({ module: "auto-resume-watcher" });
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    const records = await this.storage.list();
    for (const record of records) {
      if (!record.autoResume || record.archivedAt) continue;
      this.arm(record.id, record.autoResume.at, record.autoResume.attempt);
    }
    this.heartbeat = setInterval(() => {
      void this.sweep().catch((error) =>
        this.logger.warn({ err: error }, "Auto-resume heartbeat sweep failed"),
      );
    }, AUTO_RESUME_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async setEnabled(agentId: string, enabled: boolean): Promise<void> {
    await this.manager.setAutoResumeEnabled(agentId, enabled);
    if (!enabled) {
      this.clearTimer(agentId);
      return;
    }
    // Enabling after the limit already hit is the common flow — check immediately.
    await this.checkAgent(agentId);
  }

  onTurnEnded(agentId: string): void {
    void this.checkAgent(agentId).catch((error) =>
      this.logger.warn({ err: error, agentId }, "Auto-resume check failed"),
    );
  }

  /** Manual "Resume now": user overrides detection. Skips usage verification. */
  async triggerNow(agentId: string): Promise<void> {
    const view = this.manager.getAutoResumeView(agentId);
    if (!view) throw new Error(`Agent ${agentId} not found`);
    if (view.running) throw new Error("Agent is already running");
    this.clearTimer(agentId);
    await this.manager.setPendingAutoResume(agentId, null);
    await this.manager.runAgent(agentId, AUTO_RESUME_PROMPT);
  }

  private async sweep(): Promise<void> {
    for (const agentId of this.manager.listAutoResumeAgents()) {
      const view = this.manager.getAutoResumeView(agentId);
      if (!view || view.running || view.pending) continue;
      await this.checkAgent(agentId, { forceRefresh: false });
    }
  }

  private async checkAgent(agentId: string, options?: { forceRefresh?: boolean }): Promise<void> {
    const view = this.manager.getAutoResumeView(agentId);
    if (!view || !view.enabled || view.running || view.pending) return;
    const usage = await this.loadUsage(view.provider, options?.forceRefresh ?? true);
    const at = selectAutoResumeAt(usage, this.now());
    if (at === null) return;
    await this.manager.setPendingAutoResume(agentId, { at, attempt: 1 });
    this.arm(agentId, at, 1);
    this.logger.info({ agentId, at: new Date(at).toISOString() }, "Auto-resume scheduled");
  }

  private arm(agentId: string, at: number, attempt: number): void {
    this.clearTimer(agentId);
    const delay = Math.max(0, at - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      void this.fire(agentId, attempt).catch((error) =>
        this.logger.warn({ err: error, agentId }, "Auto-resume fire failed"),
      );
    }, delay);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private async fire(agentId: string, attempt: number): Promise<void> {
    const view = this.manager.getAutoResumeView(agentId);
    if (!view || !view.enabled || !view.pending) return;
    if (view.running) {
      // Someone resumed it already; nothing to do.
      await this.manager.setPendingAutoResume(agentId, null);
      return;
    }
    if (
      view.lastUserMessageAt !== null &&
      view.lastUserMessageAt > view.pending.at - this.armWindowMs(view.pending)
    ) {
      // The user prompted after the limit hit — they took over. (Manager also clears
      // pending on user prompts; this is the belt to that suspender.)
      await this.manager.setPendingAutoResume(agentId, null);
      return;
    }
    const usage = await this.loadUsage(view.provider, true);
    const stillExhaustedUntil = selectAutoResumeAt(usage, this.now());
    if (stillExhaustedUntil !== null) {
      if (attempt >= AUTO_RESUME_MAX_ATTEMPTS) {
        this.logger.warn({ agentId }, "Auto-resume giving up: window still exhausted");
        await this.manager.setPendingAutoResume(agentId, null);
        return;
      }
      const nextAttempt = attempt + 1;
      await this.manager.setPendingAutoResume(agentId, {
        at: stillExhaustedUntil,
        attempt: nextAttempt,
      });
      this.arm(agentId, stillExhaustedUntil, nextAttempt);
      return;
    }
    await this.manager.setPendingAutoResume(agentId, null);
    await this.manager.runAgent(agentId, AUTO_RESUME_PROMPT);
    this.logger.info({ agentId }, "Auto-resume fired");
  }

  private armWindowMs(pending: { at: number }): number {
    // How far back "user prompted after the limit hit" reaches: from arming to fire.
    return Math.max(0, pending.at - this.now()) + AUTO_RESUME_BUFFER_MS;
  }

  private async loadUsage(
    providerId: string,
    forceRefresh: boolean,
  ): Promise<ProviderUsage | undefined> {
    const nowMs = this.now();
    const shouldForce =
      forceRefresh && nowMs - this.lastForcedFetchMs >= MIN_FORCED_FETCH_INTERVAL_MS;
    if (shouldForce) this.lastForcedFetchMs = nowMs;
    const result = await this.usageService.listUsage({ forceRefresh: shouldForce });
    return result.providers.find((provider) => provider.providerId === providerId);
  }

  private clearTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }
}
```

Note: if the `lastUserMessageAt` guard proves awkward against the real manager types, drop it — the manager already clears pending on user prompts (Task 3 Step 3); the fire-time `!view.pending` check then covers it. Do not invent extra state to keep it.

- [ ] **Step 4: Add watcher behavior tests (stub deps)**

Extend `auto-resume.test.ts` with a minimal manager/usage-service stub (plain objects implementing only the methods above — type with `as unknown as AgentManager` only at the constructor boundary, keeping the stub itself fully typed against the methods used). Use vitest fake timers.

```ts
describe("AutoResumeWatcher", () => {
  test("checkAgent on turn end arms a timer and persists pending state", async () => {
    // stub: enabled agent, idle, no pending; usage returns exhausted five_hour window
    // call watcher.onTurnEnded("a1"); await flush
    // expect manager.setPendingAutoResume called with { at: reset + buffer, attempt: 1 }
  });

  test("fire verifies reset and reschedules when still exhausted, giving up after max attempts", async () => {
    // usage still exhausted at fire time -> expect setPendingAutoResume with attempt 2, no runAgent
    // repeat past AUTO_RESUME_MAX_ATTEMPTS -> pending cleared, runAgent never called
  });

  test("fire resumes with AUTO_RESUME_PROMPT when the window has reset", async () => {
    // usage healthy at fire time -> expect runAgent("a1", AUTO_RESUME_PROMPT) and pending cleared
  });

  test("triggerNow resumes immediately without usage verification and rejects while running", async () => {
    // running: expect rejects; idle: expect runAgent called even though usage still exhausted
  });

  test("setEnabled(false) clears the armed timer", async () => {
    // arm, disable, advance timers past `at` -> runAgent never called
  });
});
```

Write these as real tests (the comments describe the assertions to write, not placeholders to leave).

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/server/src/server/agent/auto-resume.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/agent/auto-resume.ts packages/server/src/server/agent/auto-resume.test.ts
git commit -m "feat(server): usage-driven auto-resume watcher with verify-before-fire"
```

---

### Task 5: Server — wiring: shared ProviderUsageService, watcher lifecycle, RPC handlers, feature flag

**Files:**

- Modify: `packages/server/src/server/bootstrap.ts`
- Modify: `packages/server/src/server/websocket-server.ts` (accept injected `ProviderUsageService`, ~line 701; advertise feature, ~line 1577)
- Modify: `packages/server/src/server/session.ts` (RPC handlers, near the `agent.detach.request` case at ~line 1901; deps at ~line 466)

**Interfaces:**

- Consumes: `AutoResumeWatcher` (Task 4), `onAgentTurnEnded` option (Task 3), RPC schemas (Task 1).
- Produces: running daemon behavior; `features.autoResumeOnLimit: true` in server_info.

- [ ] **Step 1: Share one ProviderUsageService**

`websocket-server.ts` currently constructs its own (`this.providerUsageService = new ProviderUsageService({...})`, line 701). Add an optional constructor option `providerUsageService?: ProviderUsageService`; use it when provided, else construct as today. In `bootstrap.ts`, construct the service once near the AgentManager creation and pass it to both the websocket server and the watcher (one shared 5-minute cache).

- [ ] **Step 2: Create and start the watcher in bootstrap**

After `scheduleService.start()` (~line 1218):

```ts
const autoResumeWatcher = new AutoResumeWatcher({
  agentManager,
  providerUsageService,
  agentStorage,
  logger,
});
agentManager.setOnAgentTurnEnded(({ agentId }) => autoResumeWatcher.onTurnEnded(agentId));
await autoResumeWatcher.start();
```

(Add `setOnAgentTurnEnded` in Task 3 if you made it constructor-only; a setter matches how `setAgentArchivedCallback` works.) Call `autoResumeWatcher.stop()` in the daemon shutdown path next to the schedule service teardown. Pass the watcher into the websocket server → session deps the same way `providerUsageService` flows today (websocket-server.ts:1359 → session.ts:715/844).

- [ ] **Step 3: Session RPC handlers**

In `session.ts`, next to `case "agent.detach.request":` (~line 1901), add both cases; mirror the detach handler's response shape exactly:

```ts
      case "agent.auto_resume.set.request":
        return this.handleAgentAutoResumeSet(message);
      case "agent.auto_resume.trigger.request":
        return this.handleAgentAutoResumeTrigger(message);
```

```ts
  private async handleAgentAutoResumeSet(
    message: Extract<SessionInboundMessage, { type: "agent.auto_resume.set.request" }>,
  ): Promise<void> {
    try {
      await this.deps.autoResumeWatcher.setEnabled(message.agentId, message.enabled);
      this.send({
        type: "agent.auto_resume.set.response",
        payload: { requestId: message.requestId, accepted: true, error: null },
      });
    } catch (error) {
      this.send({
        type: "agent.auto_resume.set.response",
        payload: {
          requestId: message.requestId,
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
```

`handleAgentAutoResumeTrigger` is identical with `triggerNow(message.agentId)`. **Important:** `triggerNow` calls `runAgent`, which awaits the whole turn — fire it with `void ... .catch(...)` after validating the agent exists and is idle, and respond `accepted: true` immediately; do not block the RPC on a full agent turn. Match the payload field names to `AgentActionResponsePayloadSchema` (check the schema — if it uses different keys, copy the detach handler verbatim and adjust).

- [ ] **Step 4: Advertise the feature**

In `websocket-server.ts` features block (~line 1577):

```ts
        // COMPAT(autoResumeOnLimit): added in vNEXT, remove gate once daemon floor >= vNEXT.
        autoResumeOnLimit: true,
```

- [ ] **Step 5: Verify**

Run: `npm run build:server && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/bootstrap.ts packages/server/src/server/websocket-server.ts packages/server/src/server/session.ts
git commit -m "feat(server): wire auto-resume watcher, RPC handlers, feature flag"
```

---

### Task 6: Client — daemon-client methods

**Files:**

- Modify: `packages/client/src/daemon-client.ts` (next to `detachAgent`, ~line 2468)

**Interfaces:**

- Produces: `DaemonClient.setAgentAutoResume(agentId: string, enabled: boolean): Promise<void>` and `DaemonClient.triggerAgentAutoResume(agentId: string): Promise<void>`.

- [ ] **Step 1: Implement both methods (copy the detach pattern)**

```ts
  async setAgentAutoResume(agentId: string, enabled: boolean): Promise<void> {
    const payload = await this.sendNamespacedCorrelatedSessionRequest<"agent.auto_resume.set.response">({
      message: {
        type: "agent.auto_resume.set.request",
        agentId,
        enabled,
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "setAgentAutoResume rejected");
    }
  }

  async triggerAgentAutoResume(agentId: string): Promise<void> {
    const payload = await this.sendNamespacedCorrelatedSessionRequest<"agent.auto_resume.trigger.response">({
      message: {
        type: "agent.auto_resume.trigger.request",
        agentId,
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "triggerAgentAutoResume rejected");
    }
  }
```

- [ ] **Step 2: Build + typecheck**

Run: `npm run build:client && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/daemon-client.ts
git commit -m "feat(client): setAgentAutoResume / triggerAgentAutoResume RPC methods"
```

---

### Task 7: App — snapshot plumbing into the session store

**Files:**

- Modify: `packages/app/src/stores/session-store.ts` (`Agent` interface, ~line 129)
- Modify: `packages/app/src/utils/agent-snapshots.ts` (`normalizeAgentSnapshot`, ~line 40)
- Modify: `packages/app/src/runtime/replica-cache/index.ts` (persisted agent shape — find where `lastError` is cached and mirror it)
- Test: existing snapshot fixtures that enumerate agent fields — run `packages/app/src/runtime/host-runtime.test.ts` and `packages/app/src/utils/agent-directory-reconciliation.test.ts`; both broke on the old branch when these fields were added, so expect to update their expected objects.

**Interfaces:**

- Produces: `Agent.autoResumeOnLimit?: boolean` and `Agent.autoResumeAt?: Date | null` available anywhere the session store is read.
- Consumes: Task 1 snapshot fields.

- [ ] **Step 1: Extend the `Agent` interface**

In `session-store.ts` after `lastError?: string | null;`:

```ts
  autoResumeOnLimit?: boolean;
  autoResumeAt?: Date | null;
```

- [ ] **Step 2: Normalize the snapshot**

In `agent-snapshots.ts` `normalizeAgentSnapshot`, alongside the other date conversions:

```ts
const autoResumeAt = snapshot.autoResumeAt ? new Date(snapshot.autoResumeAt) : null;
```

and in the returned object after `lastError`:

```ts
    autoResumeOnLimit: snapshot.autoResumeOnLimit ?? false,
    autoResumeAt,
```

- [ ] **Step 3: Mirror in the replica cache**

In `replica-cache/index.ts`, find where agent fields like `lastError` are serialized/revived and add both fields the same way (`autoResumeAt` as epoch ms or ISO in the cached form, revived to `Date`). Follow the file's existing convention exactly.

- [ ] **Step 4: Run the affected tests, fix fixtures**

Run:

```bash
npx vitest run packages/app/src/runtime/host-runtime.test.ts --bail=1
npx vitest run packages/app/src/utils/agent-directory-reconciliation.test.ts --bail=1
```

Update expected agent objects to include the new fields where the tests do full-shape equality. Expected: PASS after fixture updates.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/session-store.ts packages/app/src/utils/agent-snapshots.ts packages/app/src/runtime/replica-cache/index.ts packages/app/src/runtime/host-runtime.test.ts packages/app/src/utils/agent-directory-reconciliation.test.ts
git commit -m "feat(app): auto-resume fields in agent snapshots and session store"
```

---

### Task 8: App — toggle in the context-window popup

**Files:**

- Modify: `packages/app/src/components/context-window-meter.tsx`
- Modify: `packages/app/src/composer/index.tsx` (pass `agentId` through `renderContextWindowMeter`, ~lines 256–281 and the call at ~line 1819)
- Modify: all 9 i18n resource files `packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`

**Interfaces:**

- Consumes: `useHostFeature(serverId, "autoResumeOnLimit")` from `@/runtime/host-features`, `Switch` from `@/components/ui/switch`, session-store fields (Task 7), `client.setAgentAutoResume` (Task 6) via `useSessionStore.getState().sessions[serverId]?.client`.
- Produces: popup section rendered under `ProviderUsageTooltipSection`.

- [ ] **Step 1: Thread `agentId` into the meter**

In `composer/index.tsx`, add an `agentId: string` parameter to `renderContextWindowMeter` and pass it as a prop; `agentId` is already in scope at the `useMemo` call site (add it to the dependency array). In `context-window-meter.tsx`, add `agentId?: string` to `ContextWindowMeterProps`.

- [ ] **Step 2: Add the toggle section**

In `ContextWindowMeter`, after `ProviderUsageTooltipSection` (line 236):

```tsx
<AutoResumeToggleSection serverId={serverId} agentId={agentId} provider={provider} />
```

New component in the same file (it shares the tooltip styles):

```tsx
function AutoResumeToggleSection({
  serverId,
  agentId,
  provider,
}: {
  serverId?: string;
  agentId?: string;
  provider?: string | null;
}) {
  const { t } = useTranslation();
  // COMPAT(autoResumeOnLimit): hide until the daemon advertises the feature.
  const supported = useHostFeature(serverId ?? null, "autoResumeOnLimit");
  const agent = useSessionStore((state) =>
    serverId && agentId ? (state.sessions[serverId]?.agents?.get(agentId) ?? null) : null,
  );
  const [busy, setBusy] = useState(false);
  if (!supported || !serverId || !agentId || !agent) return null;
  // Only providers whose usage the daemon can read can be watched.
  if (provider !== "claude" && provider !== "codex") return null;

  const enabled = agent.autoResumeOnLimit ?? false;
  const onToggle = async (next: boolean) => {
    const client = useSessionStore.getState().sessions[serverId]?.client;
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.setAgentAutoResume(agentId, next);
    } catch {
      // snapshot stream is the source of truth; a failed call simply leaves the switch as-is
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View style={styles.autoResumeDivider} />
      <View style={styles.autoResumeRow}>
        <Text style={styles.tooltipText}>{t("contextWindow.autoResume.toggle")}</Text>
        <Switch value={enabled} onValueChange={(next) => void onToggle(next)} disabled={busy} />
      </View>
      {agent.autoResumeAt ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.autoResume.scheduled", {
            time: agent.autoResumeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
          })}
        </Text>
      ) : null}
    </>
  );
}
```

Check `@/components/ui/switch`'s actual prop names (`value`/`onValueChange`/`disabled`) and adjust. Add styles mirroring `tooltip-section.tsx`'s divider:

```ts
  autoResumeDivider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  autoResumeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
```

- [ ] **Step 3: i18n keys — all locales**

In `en.ts` inside the existing `contextWindow` block:

```ts
    autoResume: {
      toggle: "Auto-resume when limit resets",
      scheduled: "Resumes at {{time}}",
    },
```

Add the same keys with translations to `ar`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN` (the parity test `packages/app/src/i18n/resources.test.ts` fails on missing keys). Match the tone of neighboring translations in each file.

- [ ] **Step 4: Verify**

Run:

```bash
npx vitest run packages/app/src/i18n/resources.test.ts --bail=1
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/context-window-meter.tsx packages/app/src/composer/index.tsx packages/app/src/i18n/resources/*.ts
git commit -m "feat(app): auto-resume toggle in the context-window usage popup"
```

---

### Task 9: App — "will automatically resume at {time}" banner + Resume now

**Files:**

- Modify: `packages/app/src/panels/agent-panel.tsx`
- Modify: all 9 i18n resource files (new `agentPanel.autoResume.*` keys)

**Interfaces:**

- Consumes: `agentState.autoResumeAt` (already selected once Task 7 lands — extend `ChatAgentStateShape`/`selectChatAgentState` as below), `useHostFeature`, `client.triggerAgentAutoResume` (Task 6), `Alert as InlineAlert` from `@/components/ui/alert`, `Button` from `@/components/ui/button` (verify the export name; use whatever the panel already imports for inline actions if different).

- [ ] **Step 1: Select the field**

In `agent-panel.tsx` (the old branch did the same; copy from `rtk proxy git diff main...feat/auto-resume-usage-limit -- packages/app/src/panels/agent-panel.tsx`): add `autoResumeAt?: Agent["autoResumeAt"] | null;` to `ChatAgentStateShape` (~line 119), `autoResumeAt: agent.autoResumeAt ?? null,` in `selectChatAgentState` (~line 174), and thread it through `buildChatAgentFromState` / the `AgentPanelBody` state object (~lines 202, 738) exactly as the branch diff shows.

- [ ] **Step 2: Render the banner**

In `ChatAgentReadyContent` (~line 1230):

```tsx
const supportsAutoResumeOnLimit = useHostFeature(serverId, "autoResumeOnLimit");
const autoResumeAt =
  supportsAutoResumeOnLimit && agentState.autoResumeAt instanceof Date && !isAgentRunning
    ? agentState.autoResumeAt
    : null;
```

**Do NOT gate on `status === "error"`** (the old branch did; it never shows for Claude because limit-hit turns end as success). Use whatever running-state boolean the component already has (search `isAgentRunning` / the status the composer's `contextWindowPending` uses); if none is in scope, gate on `effectiveAgent.status !== "running"`.

Render above the composer, next to the existing `showHistorySyncError` callout (~line 1320):

```tsx
{
  autoResumeAt ? (
    <InlineAlert
      title={t("agentPanel.autoResume.title")}
      description={t("agentPanel.autoResume.description", {
        time: autoResumeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      })}
      action={{
        label: t("agentPanel.autoResume.resumeNow"),
        onPress: () => {
          const client = useSessionStore.getState().sessions[serverId]?.client;
          if (client) void client.triggerAgentAutoResume(agentId).catch(() => {});
        },
      }}
    />
  ) : null;
}
```

Open `packages/app/src/components/ui/alert.tsx` first: if `Alert` has no `action` prop, render the button as a sibling `Button` (variant matching other inline callout actions in this file) inside a wrapping `View` instead — do not extend the Alert component for this one caller unless the extension is a one-liner.

- [ ] **Step 3: i18n keys — all locales**

`en.ts`, new block under `agentPanel` (find the existing `agentPanel` object):

```ts
    autoResume: {
      title: "Usage limit reached",
      description: "This session will automatically resume at {{time}}.",
      resumeNow: "Resume now",
    },
```

Translate for the other 8 locales.

- [ ] **Step 4: Verify**

Run:

```bash
npx vitest run packages/app/src/i18n/resources.test.ts --bail=1
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/panels/agent-panel.tsx packages/app/src/i18n/resources/*.ts
git commit -m "feat(app): auto-resume banner with resume time and manual Resume now"
```

---

### Task 10: End-to-end verification and docs

**Files:**

- Modify: `docs/agent-lifecycle.md` (one short subsection: what auto-resume is, that detection is usage-window-based, where the toggle lives)

- [ ] **Step 1: Full static pass**

Run: `npm run build:server && npm run typecheck && npm run lint && npm run format`
Expected: all PASS; commit any formatter output.

- [ ] **Step 2: Targeted test sweep (only files this plan touched)**

```bash
npx vitest run packages/server/src/server/agent/auto-resume.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-storage.test.ts --bail=1
npx vitest run packages/app/src/runtime/host-runtime.test.ts --bail=1
npx vitest run packages/app/src/utils/agent-directory-reconciliation.test.ts --bail=1
npx vitest run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: PASS. For anything broader, push and let CI run it.

- [ ] **Step 3: Manual QA on the dev instance**

Do NOT touch the production daemon on port 6767. Use the repo dev daemon (`npm run dev`, PASEO_HOME=`.dev/paseo-home`) + `npm run dev:app`:

1. Open a Claude agent, open the context-window popup → toggle appears (feature-flagged) and flips; re-open popup → state persisted.
2. Simulate a limit without waiting for a real one: temporarily point the watcher check at a fixture (or stub the Claude fetcher response in `.dev`) so `five_hour` reports `remainingPct: 0, resetsAt: now + 3 minutes`; end a turn → banner shows "will automatically resume at {time}" and the popup shows "Resumes at {time}".
3. Press "Resume now" → agent runs the resume prompt immediately, banner clears.
4. Re-arm, restart the dev daemon → banner returns (state restored from storage), timer fires at the reset and the session resumes.
5. Re-arm, then send a manual prompt → pending state and banner clear.
   Capture screenshots of the popup toggle and the banner for the PR per `docs/qa.md`.

- [ ] **Step 4: Update the doc and commit**

Add to `docs/agent-lifecycle.md` a short subsection near the turn/attention material: the per-agent toggle, numeric detection (usage windows, never message text), verify-before-fire, and the manual Resume now override. Keep it to one paragraph plus a pointer at `packages/server/src/server/agent/auto-resume.ts`.

```bash
git add docs/agent-lifecycle.md
git commit -m "docs: auto-resume on usage limit"
```
