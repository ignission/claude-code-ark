import { describe, expect, it } from "vitest";
import { formatVoiceDiagnostic } from "./voice-diagnostic.js";

describe("formatVoiceDiagnostic", () => {
  it("セッション・種類・詳細を1行にする", () => {
    expect(
      formatVoiceDiagnostic({
        sessionId: "s1",
        kind: "recognition-error",
        detail: "not-allowed (auto)",
      })
    ).toBe("[Voice] session=s1 recognition-error not-allowed (auto)");
  });

  it("詳細が空なら付けない", () => {
    expect(
      formatVoiceDiagnostic({ sessionId: "s1", kind: "hidden", detail: "" })
    ).toBe("[Voice] session=s1 hidden");
  });

  it("改行や制御文字を空白にし、長さを切り詰める", () => {
    const line = formatVoiceDiagnostic({
      sessionId: "s1",
      kind: "speak",
      detail: `a\nb[31m${"x".repeat(300)}`,
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("");
    expect(line?.length).toBeLessThanOrEqual(
      "[Voice] session=s1 speak ".length + 200
    );
  });

  it("形が違えば null", () => {
    expect(formatVoiceDiagnostic(null)).toBeNull();
    expect(formatVoiceDiagnostic({ sessionId: 1, kind: "x" })).toBeNull();
    expect(formatVoiceDiagnostic({ sessionId: "s1" })).toBeNull();
  });
});
