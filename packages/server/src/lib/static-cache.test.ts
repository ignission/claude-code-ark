import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  staticCacheControl,
} from "./static-cache.js";

describe("staticCacheControl", () => {
  const root = "/srv/ark/web/dist";

  it.each([
    "/srv/ark/web/dist/assets/index-DMiUuS0u.js",
    "/srv/ark/web/dist/assets/index-B2rdAUn1.css",
    "/srv/ark/web/dist/assets/inter-latin-400-normal-C38fXH4l.woff2",
  ])("ハッシュ付きのアセット %s は再検証なしで使い回す", file => {
    expect(staticCacheControl(root, file)).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it.each([
    "/srv/ark/web/dist/index.html",
    "/srv/ark/web/dist/manifest.webmanifest",
    "/srv/ark/web/dist/icon-192.png",
  ])("名前が変わらないファイル %s は毎回確かめる", file => {
    expect(staticCacheControl(root, file)).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("配信ルートの外にある assets は長期キャッシュにしない", () => {
    expect(
      staticCacheControl(root, "/srv/other/assets/index-DMiUuS0u.js")
    ).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("ルートの末尾に区切りが付いていても同じ結果になる", () => {
    expect(
      staticCacheControl(`${root}/`, `${root}/assets/index-DMiUuS0u.js`)
    ).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it.each([
    "/srv/ark/web/dist/assets/a.js",
    "/srv/ark/web/dist/assets/logo.svg",
  ])("assets にあってもハッシュの無い %s は毎回確かめる", file => {
    expect(staticCacheControl(root, file)).toBe(REVALIDATE_CACHE_CONTROL);
  });
});
