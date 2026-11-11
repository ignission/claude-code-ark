/**
 * 辞書の外に日本語の文が残っていないことを確かめる。
 *
 * コメントを除いたソースに仮名か漢字が残っていたら落とす。文字列、テンプレート、JSXの地の文を
 * 区別せずに見る (構文を解釈しないので、複数行のJSXも取りこぼさない)。
 * 訳してはいけない文字 (照合に使う句読点など) は、ファイルごとに `ALLOWED` へ理由つきで書く。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

/** 見る場所。多言語化が済んだパッケージを足していく */
const SCANNED_DIRS = ["packages/web/src"];

/** 辞書そのもの */
const DICTIONARY_DIR = "packages/shared/src/i18n/";

/**
 * 訳さずに残す文字。キーはリポジトリ相対のパス、値は残してよい文字の並び。
 * 足すときは、なぜ訳せないかを横に書く。
 */
const ALLOWED: Record<string, string> = {
  // 言語の名前は、その言語自身で書く
  "packages/web/src/lib/i18n.ts": "日本語",
  // 文の区切りと文末を見る正規表現。返答が日本語のことがあるので、英語のときも日本語の句読点を見る
  "packages/web/src/lib/speech-text.ts": "。！？",
};

/**
 * まだ置き換えていないファイル (Gitタブ、ファイル、ボード、TODO、モバイル、音声)。
 * 次の変更で置き換え、この一覧ごと消す。ここへ新しく足さない。
 */
const PENDING = new Set([
  "packages/web/src/components/DiagramPane.tsx",
  "packages/web/src/components/DiagramSwitcher.tsx",
  "packages/web/src/components/FileEditor.tsx",
  "packages/web/src/components/FilePane.tsx",
  "packages/web/src/components/FilePeek.tsx",
  "packages/web/src/components/FileTree.tsx",
  "packages/web/src/components/FileViewerPane.tsx",
  "packages/web/src/components/git/GitCommitDetail.tsx",
  "packages/web/src/components/git/GitCommitList.tsx",
  "packages/web/src/components/git/GitPane.tsx",
  "packages/web/src/components/git/GitRefLabels.tsx",
  "packages/web/src/components/git/GitSidebar.tsx",
  "packages/web/src/components/git/useGitOps.tsx",
  "packages/web/src/components/HtmlViewerPane.tsx",
  "packages/web/src/components/MobileLayout.tsx",
  "packages/web/src/components/MobileQuickActionRow.tsx",
  "packages/web/src/components/MobileSessionList.tsx",
  "packages/web/src/components/MobileSessionViewModeToggle.tsx",
  "packages/web/src/components/MobileSessionView.tsx",
  "packages/web/src/components/TodoPane.tsx",
  "packages/web/src/components/VoiceModeOverlay.tsx",
  "packages/web/src/hooks/useVoiceMode.ts",
  "packages/web/src/lib/diagram-browser.ts",
  "packages/web/src/lib/diagram-delete-state.ts",
  "packages/web/src/lib/diagram-delete-transport.ts",
  "packages/web/src/lib/file-api.ts",
  "packages/web/src/lib/git-api.ts",
  "packages/web/src/lib/git-format.ts",
  "packages/web/src/lib/speech-text.ts",
  "packages/web/src/lib/todo-api.ts",
  "packages/web/src/lib/todo-draft.ts",
  "packages/web/src/lib/voice-mode-machine.ts",
]);

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const JAPANESE_OR_PUNCT =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}、。「」！？]/u;

/**
 * コメントを空白に置き換える。行数は保つ。
 * 文字列とテンプレートの中の `//` はコメントと見なさない。
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      // 引用符は行をまたがない。JSXの地の文のアポストロフィを文字列の始まりと
      // 読み違えても、その行で打ち切る
      if (ch === quote || (ch === "\n" && quote !== "`")) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/" && source[i - 1] !== ":") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listSourceFiles(rel));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/(\.test|test-helpers)\.tsx?$/.test(entry.name)
    )
      files.push(rel);
  }
  return files;
}

function findViolations(): string[] {
  const violations: string[] = [];
  for (const file of SCANNED_DIRS.flatMap(listSourceFiles)) {
    if (file.startsWith(DICTIONARY_DIR) || PENDING.has(file)) continue;
    const allowed = new Set(ALLOWED[file] ?? "");
    const lines = stripComments(
      readFileSync(path.join(REPO_ROOT, file), "utf8")
    ).split("\n");
    lines.forEach((line, index) => {
      // 句読点だけの行 (照合用の正規表現など) も、許可が無ければ拾う
      const hit = [...line].some(
        c => JAPANESE_OR_PUNCT.test(c) && !allowed.has(c)
      );
      if (hit) violations.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return violations;
}

describe("stripComments", () => {
  it("行コメントとブロックコメントを落とし、行数を保つ", () => {
    const stripped = stripComments(
      'const a = "あ"; // い\n/* う\n え */\nconst b = 1;'
    );
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).toContain('"あ"');
    expect(JAPANESE.test(stripped.replace('"あ"', ""))).toBe(false);
  });

  it("文字列とテンプレートの中の // は残す", () => {
    expect(stripComments('const u = "http://あ";')).toContain("あ");
    expect(stripComments("const u = `a // あ`;")).toContain("あ");
  });

  it("JSXのコメントを落とす", () => {
    expect(JAPANESE.test(stripComments("<p>{/* あ */}</p>"))).toBe(false);
  });
});

describe("辞書の外の日本語", () => {
  it("コメント以外に残っていない", () => {
    expect(findViolations()).toEqual([]);
  });
});
