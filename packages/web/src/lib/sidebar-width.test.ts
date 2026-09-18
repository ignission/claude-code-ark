import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  MAIN_PANE_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarMaxWidth,
} from "./sidebar-width";

describe("sidebarMaxWidth", () => {
  it("広いウィンドウでは、これまでどおり450pxで頭打ちにする", () => {
    expect(sidebarMaxWidth(1280)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidth(1024)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("狭いウィンドウでは、メインペインの最低幅を残せるところまで下げる", () => {
    // 860 - 480 = 380
    expect(sidebarMaxWidth(860)).toBe(860 - MAIN_PANE_MIN_WIDTH);
    // 768 - 480 = 288
    expect(sidebarMaxWidth(768)).toBe(768 - MAIN_PANE_MIN_WIDTH);
  });

  it("サイドバーの最低幅は下回らない (PCレイアウトが出ない幅での保険)", () => {
    expect(sidebarMaxWidth(600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarMaxWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("ウィンドウ幅が取れないときは、これまでの上限だけで判断する", () => {
    expect(sidebarMaxWidth(Number.NaN)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("clampSidebarWidth", () => {
  it("ユーザーの実設定 (253px) は、PCレイアウトが出る一番狭い幅でも丸めない", () => {
    expect(clampSidebarWidth(253, 768)).toBe(253);
    expect(clampSidebarWidth(253, 1280)).toBe(253);
  });

  it("保存済みの幅が新しい上限を超えていれば、上限まで丸める", () => {
    expect(clampSidebarWidth(450, 860)).toBe(380);
    expect(clampSidebarWidth(450, 768)).toBe(288);
    expect(clampSidebarWidth(450, 1024)).toBe(450);
  });

  it("最低幅は保つ", () => {
    expect(clampSidebarWidth(0, 1280)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(-100, 1280)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("数値でない幅は既定値に落とす", () => {
    expect(clampSidebarWidth(Number.NaN, 1280)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("丸めたあとは、メインペインに最低幅が残る", () => {
    for (const viewport of [768, 800, 860, 1024, 1280]) {
      expect(
        viewport - clampSidebarWidth(450, viewport)
      ).toBeGreaterThanOrEqual(MAIN_PANE_MIN_WIDTH);
    }
  });
});
