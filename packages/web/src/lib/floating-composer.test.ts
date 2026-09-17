import { describe, expect, it } from "vitest";
import { FLOATING_BAR_BOTTOM, floatingBarReserve } from "./floating-composer";

describe("floating-composer", () => {
  it("バーの下端からの距離は12pxとsafe areaの大きい方", () => {
    expect(FLOATING_BAR_BOTTOM).toBe("max(12px, env(safe-area-inset-bottom))");
  });

  it("余白は、実測の高さ・下端からの距離・12pxを足したcalc", () => {
    expect(floatingBarReserve(96)).toBe(
      "calc(96px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
  });

  it("小数の高さは切り上げ、負の値は0として扱う", () => {
    expect(floatingBarReserve(95.2)).toBe(
      "calc(96px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
    expect(floatingBarReserve(-1)).toBe(
      "calc(0px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
  });
});
