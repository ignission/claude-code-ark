import { describe, expect, it } from "vitest";
import { parseScreenSelection, screenSelectionId } from "./screen-selection";

describe("screen-selection", () => {
  it("screen:<id> を往復できる", () => {
    expect(screenSelectionId("s1")).toBe("screen:s1");
    expect(parseScreenSelection("screen:s1")).toBe("s1");
  });

  it("番兵でなければ null", () => {
    expect(parseScreenSelection("session-1")).toBeNull();
    expect(parseScreenSelection("browser")).toBeNull();
    expect(parseScreenSelection(null)).toBeNull();
  });
});
