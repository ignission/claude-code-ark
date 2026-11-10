import { afterEach, describe, expect, it } from "vitest";
import {
  currentLocale,
  hasLocaleHint,
  localeFromHeaders,
  m,
  parseAcceptLanguage,
  runWithLocale,
  setLastSeenLocaleForTest,
} from "./i18n";

afterEach(() => {
  setLastSeenLocaleForTest("ja");
});

describe("parseAcceptLanguage", () => {
  it("q の重みが大きい順に並べ、同じ重みは書かれた順にする", () => {
    expect(parseAcceptLanguage("en;q=0.8, ja-JP, fr;q=0.9")).toEqual([
      "ja-JP",
      "fr",
      "en",
    ]);
    expect(parseAcceptLanguage("en-US,en;q=0.9,ja;q=0.8")).toEqual([
      "en-US",
      "en",
      "ja",
    ]);
  });

  it("ヘッダが無いか * だけなら空にする", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("*")).toEqual([]);
  });
});

describe("localeFromHeaders", () => {
  it("cookie の選択を Accept-Language より優先する", () => {
    expect(
      localeFromHeaders({ cookie: "ark_locale=en", "accept-language": "ja" })
    ).toBe("en");
  });

  it("cookie が無ければ第1希望の言語で決める", () => {
    expect(localeFromHeaders({ "accept-language": "ja-JP,en;q=0.9" })).toBe(
      "ja"
    );
    expect(localeFromHeaders({ "accept-language": "en-US,ja;q=0.9" })).toBe(
      "en"
    );
    expect(localeFromHeaders({})).toBe("en");
  });
});

describe("hasLocaleHint", () => {
  it("cookie か Accept-Language があればブラウザと見なす", () => {
    expect(hasLocaleHint({ "accept-language": "ja" })).toBe(true);
    expect(hasLocaleHint({ cookie: "ark_locale=en" })).toBe(true);
    expect(hasLocaleHint({ cookie: "other=1" })).toBe(false);
    expect(hasLocaleHint({})).toBe(false);
  });
});

describe("runWithLocale", () => {
  it("中で始めた非同期の処理にも言語を引き継ぐ", async () => {
    const seen = await runWithLocale("en", async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return [currentLocale(), m().common.cancel];
    });
    expect(seen).toEqual(["en", "Cancel"]);
  });

  it("並行する処理の言語を混ぜない", async () => {
    const wait = (ms: number) =>
      new Promise(resolve => setTimeout(resolve, ms));
    const [a, b] = await Promise.all([
      runWithLocale("en", async () => {
        await wait(5);
        return currentLocale();
      }),
      runWithLocale("ja", async () => {
        await wait(1);
        return currentLocale();
      }),
    ]);
    expect([a, b]).toEqual(["en", "ja"]);
  });

  it("リクエストの外では、最後に見た利用者の言語を使う", () => {
    runWithLocale("en", () => {});
    expect(currentLocale()).toBe("en");
    runWithLocale("ja", () => {});
    expect(m().common.cancel).toBe("キャンセル");
  });
});
