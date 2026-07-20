/**
 * spa-fallback のテスト
 *
 * SPA フォールバック (index.html を返す catch-all) の対象判定。
 * /assets/ 配下の未ヒットに index.html を 200 で返すと、再ビルドの狭間で
 * 旧ハッシュのアセットを要求したクライアントに「偽アセット (HTML)」が
 * キャッシュされ、以後リロードしても白画面のままになる (2026-07-20 実害)。
 * アセットの未ヒットはフォールバック対象外 = 404 で明確に失敗させる。
 */

import { describe, expect, it } from "vitest";
import { SPA_FALLBACK_ROUTE_PATTERN } from "./spa-fallback.js";

describe("SPA_FALLBACK_ROUTE_PATTERN", () => {
  it.each([
    "/",
    "/session/abc",
    "/some/route",
    "/settings",
  ])("画面遷移パス %s はフォールバック対象", p => {
    expect(SPA_FALLBACK_ROUTE_PATTERN.test(p)).toBe(true);
  });

  it.each([
    "/assets/index-DMiUuS0u.js",
    "/assets/index-B2rdAUn1.css",
    "/assets/old-hash.js",
  ])("アセットパス %s はフォールバック対象外 (404 にする)", p => {
    expect(SPA_FALLBACK_ROUTE_PATTERN.test(p)).toBe(false);
  });

  it.each([
    "/ttyd/abc",
    "/proxy/8080/",
    "/browser/x",
  ])("既存の除外プレフィックス %s は引き続き対象外", p => {
    expect(SPA_FALLBACK_ROUTE_PATTERN.test(p)).toBe(false);
  });

  it("プレフィックス以外の /assets/ (深い位置) は対象のまま", () => {
    expect(SPA_FALLBACK_ROUTE_PATTERN.test("/docs/assets/x")).toBe(true);
  });
});
