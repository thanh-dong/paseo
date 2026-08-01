import type { AgentProvider } from "./agent-sdk-types.js";

export interface UsageLimitClassification {
  resetsAt?: number;
}

const GENERIC_LIMIT_PATTERNS = [
  /\b429\b/i,
  /\brate[\s-]?limit\b/i,
  /\busage[\s-]?limit\b/i,
  /\bquota\b/i,
  /\blimit reached\b/i,
  /\btoo many requests\b/i,
  /\boverloaded_error\b/i,
];

const PROVIDER_LIMIT_PATTERNS: Partial<Record<AgentProvider, RegExp[]>> = {
  claude: [/\bclaude ai usage limit reached\b/i, /\buntil your limit resets\b/i, /∙\s*resets?/i],
  codex: [/\btry again later\b/i, /\brequest limit\b/i],
  copilot: [/\bapi rate limit exceeded\b/i, /\bsecondary rate limit\b/i],
  opencode: [/\boverloaded_error\b/i, /\brate[- ]limited\b/i],
  pi: [/\bquota exceeded\b/i, /\brate limit exceeded\b/i],
  omp: [/\brate limit exceeded\b/i, /\bquota exceeded\b/i],
};

const RESET_SEGMENT_PATTERNS = [
  /\breset(?:s|ting)?(?:\s+at|\s+around|\s+on)?[:\s-]+([^\n.;]+)/i,
  /∙\s*resets?[:\s-]+([^\n]+)/i,
];

function normalizeText(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function matchesUsageLimit(providerId: AgentProvider, text: string): boolean {
  const providerPatterns = PROVIDER_LIMIT_PATTERNS[providerId] ?? [];
  return [...providerPatterns, ...GENERIC_LIMIT_PATTERNS].some((pattern) => pattern.test(text));
}

function parseClockTime(token: string): { hours: number; minutes: number } | null {
  const match = token.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) {
    return null;
  }
  const rawHours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isFinite(rawHours) || !Number.isFinite(minutes) || minutes > 59) {
    return null;
  }
  let hours = rawHours % 12;
  if (meridiem === "pm") {
    hours += 12;
  }
  return { hours, minutes };
}

function parseResetSegment(segment: string, now = new Date()): number | undefined {
  const trimmed = segment.trim();
  if (!trimmed) {
    return undefined;
  }

  const absoluteMs = Date.parse(trimmed);
  if (Number.isFinite(absoluteMs)) {
    return absoluteMs;
  }

  const clock = parseClockTime(trimmed);
  if (!clock) {
    return undefined;
  }

  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(clock.hours, clock.minutes, 0, 0);
  const lower = trimmed.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    target.setDate(target.getDate() + 1);
  } else if (!/\btoday\b/.test(lower) && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

export function parseUsageLimitResetTime(text: string, now = new Date()): number | undefined {
  for (const pattern of RESET_SEGMENT_PATTERNS) {
    const match = text.match(pattern);
    const segment = match?.[1];
    if (!segment) {
      continue;
    }
    const parsed = parseResetSegment(segment, now);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

export function classifyUsageLimitError(
  providerId: AgentProvider,
  error: string,
  diagnostic?: string,
): UsageLimitClassification | null {
  const text = normalizeText([error, diagnostic]);
  if (!text || !matchesUsageLimit(providerId, text)) {
    return null;
  }
  const resetsAt = parseUsageLimitResetTime(text);
  return resetsAt !== undefined ? { resetsAt } : {};
}
