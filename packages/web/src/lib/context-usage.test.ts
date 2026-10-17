import { describe, expect, it } from "vitest";
import { latestContextUsage, readContextUsage } from "./context-usage";

function assistant(
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
  model = "claude-opus-5-5"
): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model, usage, content: [] },
    ...extra,
  });
}

describe("readContextUsage", () => {
  it("input・cache_creation・cache_readの和を使用量にし、出力は数えない", () => {
    expect(
      readContextUsage(
        assistant({
          input_tokens: 2,
          cache_creation_input_tokens: 700,
          cache_read_input_tokens: 40_000,
          output_tokens: 9_999,
        })
      )
    ).toEqual({ tokens: 40_702, window: 200_000 });
  });

  it("requestedModelに[1m]が付いていれば上限を100万にする", () => {
    expect(
      readContextUsage(
        assistant(
          { input_tokens: 10, cache_read_input_tokens: 50_000 },
          { requestedModel: "claude-opus-5-5[1m]" }
        )
      )
    ).toEqual({ tokens: 50_010, window: 1_000_000 });
  });

  it("[1m]の記録が無くても、20万を超えていれば上限を100万にする", () => {
    expect(
      readContextUsage(assistant({ cache_read_input_tokens: 300_000 }))
    ).toEqual({ tokens: 300_000, window: 1_000_000 });
  });

  it("subagentの行とusageの無い行は無視する", () => {
    expect(
      readContextUsage(
        assistant({ cache_read_input_tokens: 5_000 }, { isSidechain: true })
      )
    ).toBeNull();
    expect(readContextUsage(assistant({}))).toBeNull();
    expect(readContextUsage("not json")).toBeNull();
    expect(
      readContextUsage(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "x" },
        })
      )
    ).toBeNull();
  });

  it("/compactの要約行で使用量を捨てる", () => {
    expect(
      readContextUsage(
        JSON.stringify({
          type: "user",
          isCompactSummary: true,
          message: { role: "user", content: "summary" },
        })
      )
    ).toBe("reset");
  });
});

describe("latestContextUsage", () => {
  it("最後の使用量を返し、要約より前の値は残さない", () => {
    const compact = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "summary" },
    });
    expect(
      latestContextUsage([
        assistant({ cache_read_input_tokens: 10_000 }),
        assistant({ cache_read_input_tokens: 20_000 }),
      ])
    ).toEqual({ tokens: 20_000, window: 200_000 });
    expect(
      latestContextUsage([
        assistant({ cache_read_input_tokens: 150_000 }),
        compact,
      ])
    ).toBeNull();
  });
});
