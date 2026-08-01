import { describe, expect, test } from "vitest";

import { classifyUsageLimitError, parseUsageLimitResetTime } from "./usage-limit.js";

describe("classifyUsageLimitError", () => {
  test("matches limit-shaped failures across providers", () => {
    expect(classifyUsageLimitError("codex", "429 Too Many Requests")).toEqual({});
    expect(classifyUsageLimitError("copilot", "API rate limit exceeded for this request")).toEqual(
      {},
    );
    expect(classifyUsageLimitError("opencode", "overloaded_error: please retry later")).toEqual({});
    expect(classifyUsageLimitError("pi", "API quota exceeded for this workspace")).toEqual({});
    expect(classifyUsageLimitError("omp", "rate limit exceeded; retry later")).toEqual({});
  });

  test("parses Claude reset times from provider text", () => {
    const now = new Date(2026, 7, 1, 8, 0, 0, 0);
    expect(parseUsageLimitResetTime("Claude AI usage limit reached. Resets at 3:15pm", now)).toBe(
      new Date(2026, 7, 1, 15, 15, 0, 0).getTime(),
    );
    expect(
      parseUsageLimitResetTime("Claude AI usage limit reached.\n∙ resets tomorrow 3:15pm", now),
    ).toBe(new Date(2026, 7, 2, 15, 15, 0, 0).getTime());
  });

  test("returns parsed reset times in the classification result", () => {
    const result = classifyUsageLimitError(
      "claude",
      "Claude AI usage limit reached. Resets at 3:15pm",
    );
    expect(result?.resetsAt).toBeTypeOf("number");
  });

  test("ignores broad non-provider limit phrases", () => {
    expect(classifyUsageLimitError("codex", "disk quota exceeded")).toBeNull();
    expect(classifyUsageLimitError("codex", "file size limit reached")).toBeNull();
    expect(classifyUsageLimitError("codex", "connection limit reached")).toBeNull();
    expect(classifyUsageLimitError("codex", "network timeout, try again later")).toBeNull();
  });

  test("ignores non-limit failures", () => {
    expect(classifyUsageLimitError("codex", "invalid model id")).toBeNull();
  });
});
