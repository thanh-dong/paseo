import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTO_RESUME_BUFFER_MS,
  AUTO_RESUME_MAX_ATTEMPTS,
  AUTO_RESUME_PROMPT,
} from "./auto-resume.js";
import { AutoResumeWatcher, selectAutoResumeAt } from "./auto-resume.js";
import type { ProviderUsage } from "../messages.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type {
  ProviderUsageService,
  ProviderUsageListResult,
} from "../../services/quota-fetcher/service.js";
import type { Logger } from "pino";

const NOW = Date.parse("2026-08-11T00:00:00Z");

function usage(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
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

interface AutoResumeView {
  enabled: boolean;
  pending: { at: number; attempt: number } | null;
  provider: string;
  running: boolean;
  archived: boolean;
  lastUserMessageAt: number | null;
}

/** Fully-typed stub implementing only the AgentManager methods AutoResumeWatcher calls. */
class StubAgentManager {
  views = new Map<string, AutoResumeView>();
  setAutoResumeEnabled = vi.fn(async (agentId: string, enabled: boolean) => {
    const view = this.views.get(agentId);
    if (view) view.enabled = enabled;
  });
  setPendingAutoResume = vi.fn(
    async (agentId: string, state: { at: number; attempt: number } | null) => {
      const view = this.views.get(agentId);
      if (view) view.pending = state;
    },
  );
  getAutoResumeView = vi.fn((agentId: string): AutoResumeView | null => {
    const view = this.views.get(agentId);
    return view ? { ...view } : null;
  });
  listAutoResumeAgents = vi.fn((): string[] => {
    return [...this.views.entries()].filter(([, v]) => v.enabled).map(([id]) => id);
  });
  runAgent = vi.fn(async () => ({}));

  asManager(): AgentManager {
    return this as unknown as AgentManager;
  }
}

class StubUsageService {
  listUsage = vi.fn(async (): Promise<ProviderUsageListResult> => {
    return { fetchedAt: new Date().toISOString(), providers: [this.usageFactory()] };
  });
  /** Called fresh on every fetch so tests can model resets moving relative to "now". */
  usageFactory: () => ProviderUsage = () => usage([win({})]);

  set nextUsage(value: ProviderUsage) {
    this.usageFactory = () => value;
  }

  asService(): ProviderUsageService {
    return this as unknown as ProviderUsageService;
  }
}

class StubAgentStorage {
  records: StoredAgentRecord[] = [];
  list = vi.fn(async (): Promise<StoredAgentRecord[]> => this.records);

  asStorage(): AgentStorage {
    return this as unknown as AgentStorage;
  }
}

function makeLogger(): Logger {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger as unknown as Logger;
}

const EXHAUSTED_WINDOW = win({ usedPct: 100, remainingPct: 0, resetsAt: "2026-08-11T03:00:00Z" });
const RESET_AT = Date.parse("2026-08-11T03:00:00Z") + AUTO_RESUME_BUFFER_MS;

describe("AutoResumeWatcher", () => {
  let manager: StubAgentManager;
  let usageService: StubUsageService;
  let storage: StubAgentStorage;
  let watcher: AutoResumeWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    manager = new StubAgentManager();
    usageService = new StubUsageService();
    storage = new StubAgentStorage();
    watcher = new AutoResumeWatcher({
      agentManager: manager.asManager(),
      providerUsageService: usageService.asService(),
      agentStorage: storage.asStorage(),
      logger: makeLogger(),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  test("checkAgent on turn end arms a timer and persists pending state", async () => {
    manager.views.set("a1", {
      enabled: true,
      pending: null,
      provider: "claude",
      running: false,
      archived: false,
      lastUserMessageAt: null,
    });
    usageService.nextUsage = usage([EXHAUSTED_WINDOW]);

    watcher.onTurnEnded("a1");
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenCalledWith("a1", { at: RESET_AT, attempt: 1 });
    });

    expect(manager.runAgent).not.toHaveBeenCalled();
  });

  test("fire verifies reset and reschedules when still exhausted, giving up after max attempts", async () => {
    manager.views.set("a1", {
      enabled: true,
      pending: null,
      provider: "claude",
      running: false,
      archived: false,
      lastUserMessageAt: null,
    });
    // Still-exhausted responses report a reset an hour past "now" every time they're
    // fetched, so each verification at fire time sees a fresh future reset.
    usageService.usageFactory = () =>
      usage([
        win({
          usedPct: 100,
          remainingPct: 0,
          resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      ]);
    const firstExpectedAt = NOW + 60 * 60_000 + AUTO_RESUME_BUFFER_MS;

    watcher.onTurnEnded("a1");
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenCalledWith("a1", {
        at: firstExpectedAt,
        attempt: 1,
      });
    });

    // Still exhausted at fire time -> reschedule with attempt 2, no run.
    await vi.advanceTimersByTimeAsync(firstExpectedAt - NOW);
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenLastCalledWith("a1", {
        at: expect.any(Number),
        attempt: 2,
      });
    });
    expect(manager.runAgent).not.toHaveBeenCalled();

    // Keep firing while still exhausted; after AUTO_RESUME_MAX_ATTEMPTS, give up (clear pending).
    for (let attempt = 2; attempt < AUTO_RESUME_MAX_ATTEMPTS; attempt++) {
      const pending = manager.views.get("a1")?.pending;
      expect(pending).not.toBeNull();
      const delay = (pending?.at ?? Date.now()) - Date.now();
      await vi.advanceTimersByTimeAsync(Math.max(0, delay));
      await vi.waitFor(() => {
        expect(manager.setPendingAutoResume).toHaveBeenLastCalledWith("a1", {
          at: expect.any(Number),
          attempt: attempt + 1,
        });
      });
    }

    const finalPending = manager.views.get("a1")?.pending;
    const finalDelay = (finalPending?.at ?? Date.now()) - Date.now();
    await vi.advanceTimersByTimeAsync(Math.max(0, finalDelay));
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenLastCalledWith("a1", null);
    });
    expect(manager.runAgent).not.toHaveBeenCalled();
  });

  test("fire resumes with AUTO_RESUME_PROMPT when the window has reset", async () => {
    manager.views.set("a1", {
      enabled: true,
      pending: null,
      provider: "claude",
      running: false,
      archived: false,
      lastUserMessageAt: null,
    });
    usageService.nextUsage = usage([EXHAUSTED_WINDOW]);

    watcher.onTurnEnded("a1");
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenCalledWith("a1", { at: RESET_AT, attempt: 1 });
    });

    // Window has reset by fire time.
    usageService.nextUsage = usage([win({})]);
    await vi.advanceTimersByTimeAsync(RESET_AT - NOW);

    await vi.waitFor(() => {
      expect(manager.runAgent).toHaveBeenCalledWith("a1", AUTO_RESUME_PROMPT);
    });
    expect(manager.setPendingAutoResume).toHaveBeenLastCalledWith("a1", null);
  });

  test("triggerNow resumes immediately without usage verification and rejects while running", async () => {
    manager.views.set("running-agent", {
      enabled: true,
      pending: { at: NOW + 1000, attempt: 1 },
      provider: "claude",
      running: true,
      archived: false,
      lastUserMessageAt: null,
    });
    await expect(watcher.triggerNow("running-agent")).rejects.toThrow();
    expect(manager.runAgent).not.toHaveBeenCalled();

    manager.views.set("idle-agent", {
      enabled: true,
      pending: { at: NOW + 1000, attempt: 1 },
      provider: "claude",
      running: false,
      archived: false,
      lastUserMessageAt: null,
    });
    // Usage is still exhausted, but triggerNow must skip verification entirely.
    usageService.nextUsage = usage([EXHAUSTED_WINDOW]);

    await watcher.triggerNow("idle-agent");
    expect(manager.runAgent).toHaveBeenCalledWith("idle-agent", AUTO_RESUME_PROMPT);
    expect(manager.setPendingAutoResume).toHaveBeenCalledWith("idle-agent", null);
  });

  test("setEnabled(false) clears the armed timer", async () => {
    manager.views.set("a1", {
      enabled: true,
      pending: null,
      provider: "claude",
      running: false,
      archived: false,
      lastUserMessageAt: null,
    });
    usageService.nextUsage = usage([EXHAUSTED_WINDOW]);

    watcher.onTurnEnded("a1");
    await vi.waitFor(() => {
      expect(manager.setPendingAutoResume).toHaveBeenCalledWith("a1", { at: RESET_AT, attempt: 1 });
    });

    await watcher.setEnabled("a1", false);
    expect(manager.setAutoResumeEnabled).toHaveBeenCalledWith("a1", false);

    await vi.advanceTimersByTimeAsync(RESET_AT - Date.now() + 1000);
    expect(manager.runAgent).not.toHaveBeenCalled();
  });
});
