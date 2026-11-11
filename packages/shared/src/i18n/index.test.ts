import { describe, expect, it } from "vitest";
import { getMessages, plural, readLocaleCookie, resolveLocale } from "./index";

describe("resolveLocale", () => {
  it("保存済みの選択を、ブラウザの言語より優先する", () => {
    expect(resolveLocale("en", ["ja-JP"])).toBe("en");
    expect(resolveLocale("ja", ["en-US"])).toBe("ja");
  });

  it("保存が無いか壊れていれば、第1希望の言語で決める", () => {
    expect(resolveLocale(null, ["ja"])).toBe("ja");
    expect(resolveLocale("fr", ["ja-JP", "en"])).toBe("ja");
    expect(resolveLocale(undefined, ["en-US", "ja"])).toBe("en");
  });

  it("日本語以外と、言語が分からないときは英語にする", () => {
    expect(resolveLocale(null, ["fr-FR"])).toBe("en");
    expect(resolveLocale(null, [])).toBe("en");
    // "jav" (ジャワ語) を日本語と取り違えない
    expect(resolveLocale(null, ["jav"])).toBe("en");
  });
});

describe("getMessages", () => {
  it("言語ごとの辞書を返す", () => {
    expect(getMessages("ja").common.cancel).toBe("キャンセル");
    expect(getMessages("en").common.cancel).toBe("Cancel");
  });
});

describe("plural", () => {
  it("1だけ単数にする", () => {
    expect(plural(1, "file", "files")).toBe("file");
    expect(plural(0, "file", "files")).toBe("files");
    expect(plural(2, "file", "files")).toBe("files");
  });
});

describe("readLocaleCookie", () => {
  it("ほかの cookie に混ざった値を取り出す", () => {
    expect(readLocaleCookie("a=1; ark_locale=en; b=2")).toBe("en");
    expect(readLocaleCookie("ark_locale=ja")).toBe("ja");
  });

  it("無ければ null を返す", () => {
    expect(readLocaleCookie("a=1; xark_locale=en")).toBeNull();
    expect(readLocaleCookie("")).toBeNull();
    expect(readLocaleCookie(undefined)).toBeNull();
  });
});
