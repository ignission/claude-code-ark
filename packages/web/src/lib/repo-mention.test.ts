import { describe, expect, it } from "vitest";
import {
  applyRepoMention,
  buildRepoMentionCandidates,
  collapseRepoPaths,
  expandRepoMentions,
  filterRepoMentionCandidates,
  findRepoMentionAtCaret,
} from "./repo-mention";

const SHOP = "/home/u/dev/github.com/acme/shop";
const SHOP_IOS = "/home/u/dev/github.com/acme/shop-app-ios";
const ARK = "/home/u/dev/github.com/ignission/claude-code-manager";
const APP_A = "/home/u/dev/github.com/acme/app";
const APP_B = "/home/u/dev/github.com/other/app";

const candidates = buildRepoMentionCandidates([
  SHOP,
  SHOP_IOS,
  ARK,
  APP_A,
  APP_B,
]);
const labelOf = (path: string) => candidates.find(c => c.path === path)?.label;

describe("buildRepoMentionCandidates", () => {
  it("名前が 1 つに決まるリポジトリは、ディレクトリ名を短い名前にする", () => {
    expect(labelOf(SHOP)).toBe("shop");
    expect(labelOf(SHOP_IOS)).toBe("shop-app-ios");
    expect(labelOf(ARK)).toBe("claude-code-manager");
  });

  it("同じ名前のリポジトリは、1 つに決まるところまで親を足す", () => {
    expect(labelOf(APP_A)).toBe("acme/app");
    expect(labelOf(APP_B)).toBe("other/app");
  });

  it("親ディレクトリまでのパスを添える", () => {
    expect(candidates.find(c => c.path === SHOP)?.parent).toBe(
      "/home/u/dev/github.com/acme"
    );
  });

  it("重複と絶対パスでないものを落とす", () => {
    expect(
      buildRepoMentionCandidates([SHOP, SHOP, "relative/repo"]).map(c => c.path)
    ).toEqual([SHOP]);
  });
});

describe("findRepoMentionAtCaret", () => {
  it("行頭の @ を拾う", () => {
    expect(findRepoMentionAtCaret("@sho", 4)).toEqual({
      start: 0,
      query: "sho",
    });
  });

  it("空白の直後の @ を、文の途中でも拾う", () => {
    expect(findRepoMentionAtCaret("これを @sh で直して", 7)).toEqual({
      start: 4,
      query: "sh",
    });
  });

  it("改行の直後の @ を拾う", () => {
    expect(findRepoMentionAtCaret("一行目\n@", 5)).toEqual({
      start: 4,
      query: "",
    });
  });

  it("日本語の直後の @ を拾う", () => {
    expect(findRepoMentionAtCaret("これを@sho", 7)).toEqual({
      start: 3,
      query: "sho",
    });
  });

  it("英数字に続く @ (メールアドレスなど) は拾わない", () => {
    expect(findRepoMentionAtCaret("a@b", 3)).toBeNull();
  });

  it("空白をまたいだあとは拾わない", () => {
    expect(findRepoMentionAtCaret("@shop で", 9)).toBeNull();
  });

  it("@/ で始まるファイルの参照は拾わない", () => {
    expect(findRepoMentionAtCaret("@/tmp/a.png", 11)).toBeNull();
  });
});

describe("filterRepoMentionCandidates", () => {
  it("文字が無ければ先頭から出す", () => {
    expect(filterRepoMentionCandidates(candidates, "", 2)).toHaveLength(2);
  });

  it("名前の先頭に一致するものを、短い名前から並べる", () => {
    expect(
      filterRepoMentionCandidates(candidates, "SHO").map(c => c.path)
    ).toEqual([SHOP, SHOP_IOS]);
  });

  it("パスの途中に一致するものを後ろに出す", () => {
    expect(
      filterRepoMentionCandidates(candidates, "app").map(c => c.path)
    ).toEqual([APP_A, APP_B, SHOP_IOS]);
  });

  it("一致が無ければ空", () => {
    expect(filterRepoMentionCandidates(candidates, "zzz")).toEqual([]);
  });
});

describe("applyRepoMention", () => {
  const shop = candidates.find(c => c.path === SHOP);
  if (!shop) throw new Error("fixture");

  it("打ちかけを短い名前に置き換え、空白を足してカーソルをその後ろに置く", () => {
    const value = "@sho";
    const mention = findRepoMentionAtCaret(value, 4);
    if (!mention) throw new Error("fixture");
    expect(applyRepoMention(value, mention, 4, shop)).toEqual({
      value: "@shop ",
      caret: 6,
    });
  });

  it("後ろに空白があれば足さず、前後の文を残す", () => {
    const value = "これを @sh で直して";
    const mention = findRepoMentionAtCaret(value, 7);
    if (!mention) throw new Error("fixture");
    expect(applyRepoMention(value, mention, 7, shop)).toEqual({
      value: "これを @shop で直して",
      caret: 10,
    });
  });
});

describe("expandRepoMentions", () => {
  it("@名前 を絶対パスへ置き換える", () => {
    expect(expandRepoMentions("@shop でログを直して", candidates)).toBe(
      `${SHOP} でログを直して`
    );
  });

  it("空白を挟まずに続く日本語の手前までを名前として読む", () => {
    expect(expandRepoMentions("@shopで直して", candidates)).toBe(
      `${SHOP}で直して`
    );
  });

  it("日本語の直後の @名前 も置き換える", () => {
    expect(expandRepoMentions("これを@shopで直して", candidates)).toBe(
      `これを${SHOP}で直して`
    );
  });

  it("長い名前を短い名前の一部として読まない", () => {
    expect(expandRepoMentions("@shop-app-ios を見て", candidates)).toBe(
      `${SHOP_IOS} を見て`
    );
  });

  it("手で打った owner/name も、1 つに決まれば置き換える", () => {
    expect(expandRepoMentions("@acme/shop と @acme/app", candidates)).toBe(
      `${SHOP} と ${APP_A}`
    );
  });

  it("1 つに決まらない名前と候補に無い名前は残す", () => {
    expect(expandRepoMentions("@app と @unknown", candidates)).toBe(
      "@app と @unknown"
    );
  });

  it("ファイルの参照と文中の @ は残す", () => {
    const text = "@/tmp/shop と a@shop";
    expect(expandRepoMentions(text, candidates)).toBe(text);
  });

  it("候補が無ければ何もしない", () => {
    expect(expandRepoMentions("@shop", [])).toBe("@shop");
  });
});

describe("collapseRepoPaths", () => {
  it("候補の絶対パスを @名前 へ戻す", () => {
    expect(collapseRepoPaths(`${SHOP} でログを直して`, candidates)).toBe(
      "@shop でログを直して"
    );
  });

  it("置き換えた文を元の見た目に戻せる", () => {
    for (const text of [
      "@shopで直して",
      "これを@shopで直して",
      "@shop-app-ios と @other/app を見て",
      "一行目\n@claude-code-manager",
    ]) {
      expect(
        collapseRepoPaths(expandRepoMentions(text, candidates), candidates)
      ).toBe(text);
    }
  });

  it("リポジトリの中のファイルのパスと、別のパスの一部は戻さない", () => {
    const text = `${SHOP}/src/a.ts と /mnt${SHOP} と @${SHOP}`;
    expect(collapseRepoPaths(text, candidates)).toBe(text);
  });
});
