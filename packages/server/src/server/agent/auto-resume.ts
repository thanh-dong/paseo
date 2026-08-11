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
  if (!usage || usage.status !== "available") return null;
  let latestReset: number | null = null;
  for (const window of usage.windows) {
    const remaining =
      window.remainingPct ?? (typeof window.usedPct === "number" ? 100 - window.usedPct : null);
    if (remaining === null || remaining === undefined || remaining > EXHAUSTED_REMAINING_PCT) {
      continue;
    }
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
