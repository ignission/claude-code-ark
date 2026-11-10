// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/** cookie とブラウザの言語を決めてから、モジュールを読み込み直す */
async function loadWith(cookie: string | null, language: string) {
  vi.resetModules();
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom に Cookie Store API は無い
  document.cookie = "ark_locale=; Path=/; Max-Age=0";
  // biome-ignore lint/suspicious/noDocumentCookie: 同上
  if (cookie !== null) document.cookie = `ark_locale=${cookie}; Path=/`;
  vi.spyOn(navigator, "languages", "get").mockReturnValue([language]);
  return import("./i18n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("言語の決定", () => {
  it("選択が無ければブラウザの言語で決め、html の lang に反映する", async () => {
    const en = await loadWith(null, "en-US");
    expect(en.locale).toBe("en");
    expect(en.m.common.cancel).toBe("Cancel");
    expect(document.documentElement.lang).toBe("en");

    const ja = await loadWith(null, "ja-JP");
    expect(ja.locale).toBe("ja");
    expect(ja.m.common.cancel).toBe("キャンセル");
  });

  it("cookie の選択を、ブラウザの言語より優先する", async () => {
    const mod = await loadWith("ja", "en-US");
    expect(mod.locale).toBe("ja");
  });
});

describe("changeLocale", () => {
  it("同じ言語なら何もしない", async () => {
    const mod = await loadWith(null, "en-US");
    mod.changeLocale("en");
    expect(document.cookie).not.toContain("ark_locale");
  });

  it("別の言語を選ぶと cookie に保存し、次の読み込みでその言語になる", async () => {
    const mod = await loadWith(null, "en-US");
    // jsdom の location.reload は未実装で例外を出さずに警告するだけなので、保存の結果を見る
    vi.spyOn(console, "error").mockImplementation(() => {});
    mod.changeLocale("ja");
    expect(document.cookie).toContain("ark_locale=ja");
    vi.resetModules();
    const reloaded = await import("./i18n");
    expect(reloaded.locale).toBe("ja");
  });
});
