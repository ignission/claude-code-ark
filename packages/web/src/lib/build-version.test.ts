import { describe, expect, it } from "vitest";
import {
  type BuildUpdateInput,
  decideBuildUpdate,
  parseBuildId,
} from "./build-version";

describe("parseBuildId", () => {
  it("index.html の目印から版を読む", () => {
    const html =
      '<!doctype html><html><head><meta charset="UTF-8" /><meta name="ark-build" content="mgn1x2ab"></head></html>';
    expect(parseBuildId(html)).toBe("mgn1x2ab");
  });

  it("目印の無いページ (ログイン画面や古いビルド) は null", () => {
    expect(
      parseBuildId("<html><head><title>Sign in</title></head></html>")
    ).toBe(null);
  });
});

describe("decideBuildUpdate", () => {
  const base: BuildUpdateInput = {
    current: "old",
    served: "new",
    lastReloadTarget: null,
    hasUnsavedInput: false,
  };

  it("新しい版が配られていて、書きかけが無ければ読み込み直す", () => {
    expect(decideBuildUpdate(base)).toBe("reload");
  });

  it("書きかけがあるときは読み込み直さず、利用者に知らせる", () => {
    expect(decideBuildUpdate({ ...base, hasUnsavedInput: true })).toBe(
      "prompt"
    );
  });

  it("同じ版なら何もしない", () => {
    expect(decideBuildUpdate({ ...base, served: "old" })).toBe("none");
  });

  it("配信中の版が取れなかったときは何もしない", () => {
    expect(decideBuildUpdate({ ...base, served: null })).toBe("none");
  });

  it("いまの版が分からないときは何もしない", () => {
    expect(decideBuildUpdate({ ...base, current: null })).toBe("none");
  });

  it("同じ版へ一度読み込み直していたら、繰り返さない", () => {
    expect(decideBuildUpdate({ ...base, lastReloadTarget: "new" })).toBe(
      "none"
    );
    expect(
      decideBuildUpdate({
        ...base,
        lastReloadTarget: "new",
        hasUnsavedInput: true,
      })
    ).toBe("none");
  });

  it("さらに新しい版が出たら、もう一度読み込み直す", () => {
    expect(decideBuildUpdate({ ...base, lastReloadTarget: "older" })).toBe(
      "reload"
    );
  });
});
