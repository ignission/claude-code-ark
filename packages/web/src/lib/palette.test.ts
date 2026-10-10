import { describe, expect, it } from "vitest";
import {
  askItem,
  fileItem,
  PALETTE_COMMANDS,
  PALETTE_LIMIT,
  type PaletteItem,
  rankPalette,
  regionAfter,
  scoreWord,
} from "./palette";

function session(id: string, title: string, detail: string): PaletteItem {
  return {
    id: `session:${id}`,
    kind: "session",
    title,
    detail,
    action: { type: "session", sessionId: id },
  };
}

const sessions = [
  session("s1", "claude-code-manager", "main · あなたの番"),
  session("s2", "haus", "feat/login · 作業中"),
];
const diagrams: PaletteItem[] = [
  {
    id: "diagram:a",
    kind: "diagram",
    title: "ログインの流れ",
    keywords: ".claude/diagrams/login-flow.diagram.html",
    action: {
      type: "diagram",
      relPath: ".claude/diagrams/login-flow.diagram.html",
    },
  },
];
const filePaths = [
  "packages/web/src/lib/keynav.ts",
  "packages/web/src/lib/keynav.test.ts",
  "packages/web/src/lib/keynav-dom.ts",
  "packages/web/src/components/KeyNavLayer.tsx",
  "packages/server/src/lib/login.ts",
  "README.md",
];
const sources = { sessions, diagrams, commands: PALETTE_COMMANDS, filePaths };
const titles = (query: string) => rankPalette(query, sources).map(i => i.title);

describe("scoreWord", () => {
  it("連続した一致を、飛び飛びの一致より高くする", () => {
    const run = scoreWord("keynav.ts", "nav") ?? 0;
    const scattered = scoreWord("keynav.ts", "kvt") ?? 0;
    expect(run).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  it("語の頭での一致を、途中での一致より高くする", () => {
    expect(scoreWord("key-nav", "nav") ?? 0).toBeGreaterThan(
      scoreWord("keynav", "nav") ?? 0
    );
  });

  it("含まれない文字があれば一致しない", () => {
    expect(scoreWord("keynav.ts", "kx")).toBeNull();
  });
});

describe("rankPalette", () => {
  it("何も打っていなければ、セッションとコマンドをそのままの順で出す", () => {
    const got = rankPalette("", sources);
    expect(got.slice(0, 2).map(i => i.title)).toEqual([
      "claude-code-manager",
      "haus",
    ]);
    expect(got.some(i => i.kind === "file" || i.kind === "diagram")).toBe(
      false
    );
    expect(got.at(-1)?.kind).toBe("command");
  });

  it("ファイルは最後の名前で探せ、短い名前を先に出す", () => {
    expect(titles("keynav").slice(0, 3)).toEqual([
      "keynav.ts",
      "keynav-dom.ts",
      "keynav.test.ts",
    ]);
  });

  it("大文字小文字を区別せず、飛び飛びでも探せる", () => {
    expect(titles("knl")[0]).toBe("KeyNavLayer.tsx");
    expect(titles("README")[0]).toBe("README.md");
  });

  it("空白で区切った語は、すべて含むものだけを残す (フォルダでも絞れる)", () => {
    expect(titles("server login")).toEqual(["login.ts"]);
  });

  it("種類をまたいで探す (セッション・図・ファイル・コマンド)", () => {
    const got = rankPalette("login", sources);
    expect(got.map(i => i.kind).sort()).toEqual(["diagram", "file", "session"]);
    expect(titles("git")).toContain("Git のタブを開く");
    expect(titles("ボード提案")).toEqual(["ボード提案の設定"]);
  });

  it("題での一致を、補足での一致より上に置く", () => {
    const got = rankPalette("haus", {
      ...sources,
      sessions: [session("s3", "other", "haus の隣"), ...sessions],
    });
    expect(got[0].title).toBe("haus");
  });

  it("候補の数に上限がある", () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
    const got = rankPalette("file", { ...sources, filePaths: many });
    expect(got.length).toBeLessThanOrEqual(PALETTE_LIMIT);
  });
});

describe("候補の形", () => {
  it("ファイルは最後の名前を題に、フォルダを補足にする", () => {
    expect(fileItem("a/b/c.ts")).toMatchObject({
      title: "c.ts",
      detail: "a/b",
    });
    expect(fileItem("README.md").detail).toBeUndefined();
  });

  it("「聞く」の行は、打った文があるときだけ出す", () => {
    expect(askItem("   ", "haus")).toBeNull();
    expect(askItem(" なぜ落ちる? ", "haus")).toMatchObject({
      kind: "ask",
      detail: "haus",
      action: { type: "ask", text: "なぜ落ちる?" },
    });
  });

  it("取り消せない操作をコマンドに載せない", () => {
    const text = PALETTE_COMMANDS.map(c => c.title).join(" ");
    expect(text).not.toMatch(/停止|削除|再起動/);
  });

  it("図とファイルを開いたあとは作業エリアに、聞いたあとは左のパネルにいる", () => {
    expect(regionAfter({ type: "file", path: "a" })).toBe("work");
    expect(regionAfter({ type: "diagram", relPath: "a" })).toBe("work");
    expect(regionAfter({ type: "ask", text: "a" })).toBe("left");
    expect(regionAfter({ type: "session", sessionId: "a" })).toBeUndefined();
  });
});
