import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGRAM_NOTE_TEXT_MAX, DIAGRAM_NOTES_MAX } from "@ark/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDiagramNoteOp,
  applyNoteOp,
  notesRelPathOf,
  parseNoteOp,
  parseNotes,
  readDiagramNotes,
  removeDiagramNotes,
} from "./diagram-notes.js";

const REL = ".claude/diagrams/plan.diagram.html";
let wt: string;
let dir: string;
const notesFile = () => path.join(dir, "plan.notes.json");

beforeEach(() => {
  wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-notes-")));
  dir = path.join(wt, ".claude", "diagrams");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.diagram.html"), "<p>図</p>");
});
afterEach(() => fs.rmSync(wt, { recursive: true, force: true }));

describe("付箋のファイルの場所", () => {
  it("図の名前の .diagram.html を .notes.json に替える", () => {
    expect(notesRelPathOf(REL)).toBe(".claude/diagrams/plan.notes.json");
  });
});

describe("parseNotes", () => {
  it("JSON として読めない、または notes が配列でなければ null", () => {
    expect(parseNotes("{")).toBeNull();
    expect(parseNotes('"x"')).toBeNull();
    expect(parseNotes('{"notes":{}}')).toBeNull();
  });

  it("形の合わない付箋と枠は読み飛ばして数え、残りを読む", () => {
    const parsed = parseNotes(
      JSON.stringify({
        view: { width: 1200 },
        notes: [
          { id: "a", author: "human", text: "人", x: 10.4, y: -5 },
          { id: "a", author: "human", text: "同じid", x: 0, y: 0 },
          { id: "b", text: "authorなし", x: 1, y: 2 },
          { id: "c c", author: "human", text: "idに空白", x: 1, y: 2 },
          { id: "d", author: "human", text: "位置なし" },
        ],
        frames: [
          { id: "f", label: "枠", x: 0, y: 0, w: 100, h: 50 },
          { id: "g", label: "大きさなし", x: 0, y: 0, w: 0, h: 50 },
        ],
      })
    );
    expect(parsed).toEqual({
      notes: {
        notes: [
          { id: "a", author: "human", text: "人", x: 10, y: 0 },
          // human と書かれていないものは Claude の付箋として扱う
          { id: "b", author: "claude", text: "authorなし", x: 1, y: 2 },
        ],
        frames: [{ id: "f", label: "枠", x: 0, y: 0, w: 100, h: 50 }],
      },
      dropped: 4,
      viewWidth: 1200,
    });
  });
});

describe("parseNoteOp", () => {
  it("形の合う操作だけを通し、位置は丸め、文は上限で切る", () => {
    expect(parseNoteOp({ type: "add", id: "n1", x: 3.6, y: 9 })).toEqual({
      type: "add",
      id: "n1",
      x: 4,
      y: 9,
    });
    expect(
      parseNoteOp({ type: "text", id: "n1", text: "あ".repeat(999) })
    ).toEqual({
      type: "text",
      id: "n1",
      text: "あ".repeat(DIAGRAM_NOTE_TEXT_MAX),
    });
    expect(parseNoteOp({ type: "delete", id: "n1" })).toEqual({
      type: "delete",
      id: "n1",
    });
    expect(parseNoteOp({ type: "move", id: "n1", x: "1", y: 2 })).toBeNull();
    expect(parseNoteOp({ type: "add", id: "../x", x: 1, y: 2 })).toBeNull();
    expect(parseNoteOp({ type: "paint", id: "n1" })).toBeNull();
    expect(parseNoteOp(null)).toBeNull();
  });
});

describe("applyNoteOp", () => {
  const base = {
    notes: [
      { id: "h", author: "human" as const, text: "人", x: 0, y: 0 },
      { id: "c", author: "claude" as const, text: "Claude", x: 200, y: 0 },
    ],
    frames: [{ id: "f", label: "枠", x: 0, y: 0, w: 400, h: 200 }],
  };

  it("足す、動かす、書く、消す。枠はそのまま残す", () => {
    const added = applyNoteOp(base, { type: "add", id: "n", x: 5, y: 6 });
    expect(added).not.toBe("limit");
    if (added === "limit") return;
    expect(added.notes.at(-1)).toEqual({
      id: "n",
      author: "human",
      text: "",
      x: 5,
      y: 6,
    });
    const moved = applyNoteOp(base, { type: "move", id: "c", x: 9, y: 9 });
    expect(moved).toMatchObject({ notes: [{}, { id: "c", x: 9, y: 9 }] });
    const written = applyNoteOp(base, { type: "text", id: "h", text: "新" });
    expect(written).toMatchObject({ notes: [{ text: "新" }, {}] });
    const removed = applyNoteOp(base, { type: "delete", id: "c" });
    expect(removed).toMatchObject({
      notes: [{ id: "h" }],
      frames: base.frames,
    });
  });

  it("Claude の付箋の文は書き換えない。相手の無い操作と、同じ id の追加は何もしない", () => {
    expect(applyNoteOp(base, { type: "text", id: "c", text: "x" })).toBe(base);
    expect(applyNoteOp(base, { type: "move", id: "zz", x: 1, y: 1 })).toBe(
      base
    );
    expect(applyNoteOp(base, { type: "add", id: "h", x: 1, y: 1 })).toBe(base);
  });

  it("上限まで置いてあれば、足さない", () => {
    const full = {
      notes: Array.from({ length: DIAGRAM_NOTES_MAX }, (_, i) => ({
        id: `n${i}`,
        author: "human" as const,
        text: "",
        x: 0,
        y: 0,
      })),
      frames: [],
    };
    expect(applyNoteOp(full, { type: "add", id: "more", x: 0, y: 0 })).toBe(
      "limit"
    );
  });
});

describe("読み書き", () => {
  it("付箋のファイルが無ければ空で返す", async () => {
    await expect(readDiagramNotes(wt, REL)).resolves.toEqual({
      ok: true,
      notes: { notes: [], frames: [] },
      dropped: 0,
    });
  });

  it("操作を当てて保存する。ファイルには使い方と図の幅も書く", async () => {
    const result = await applyDiagramNoteOp(
      wt,
      REL,
      { type: "add", id: "n1", x: 40, y: 30 },
      1100
    );
    expect(result).toMatchObject({
      ok: true,
      notes: { notes: [{ id: "n1" }] },
    });
    const file = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    expect(file.about).toContain("plan.diagram.html");
    expect(file.view).toEqual({ width: 1100 });
    expect(file.notes).toEqual([
      { id: "n1", author: "human", text: "", x: 40, y: 30 },
    ]);
    await expect(readDiagramNotes(wt, REL)).resolves.toEqual(result);
  });

  it("Claude が書き足した付箋と枠を、人の操作で潰さない", async () => {
    await applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 });
    const file = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    file.notes.push({ id: "c1", author: "claude", text: "答え", x: 300, y: 0 });
    file.frames.push({ id: "f1", label: "まとめ", x: 0, y: 0, w: 500, h: 200 });
    fs.writeFileSync(notesFile(), JSON.stringify(file));

    const result = await applyDiagramNoteOp(wt, REL, {
      type: "move",
      id: "n1",
      x: 20,
      y: 60,
    });
    expect(result).toMatchObject({
      ok: true,
      notes: {
        notes: [
          { id: "n1", x: 20, y: 60 },
          { id: "c1", text: "答え" },
        ],
        frames: [{ id: "f1" }],
      },
    });
  });

  it("読んでから置き換えるまでの間に Claude が書いた内容を、上書きしない", async () => {
    await applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 });
    let wrote = false;
    const result = await applyDiagramNoteOp(
      wt,
      REL,
      { type: "move", id: "n1", x: 50, y: 50 },
      undefined,
      () => {
        if (wrote) return;
        wrote = true;
        const file = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
        file.notes.push({
          id: "c1",
          author: "claude",
          text: "答え",
          x: 300,
          y: 0,
        });
        fs.writeFileSync(notesFile(), JSON.stringify(file, null, 2));
      }
    );
    // 読み直して当て直すので、Claude の付箋も、人の移動も残る
    expect(result).toMatchObject({
      ok: true,
      notes: { notes: [{ id: "n1", x: 50, y: 50 }, { id: "c1" }] },
    });
    await expect(readDiagramNotes(wt, REL)).resolves.toEqual(result);
  });

  it("置き換えのたびにファイルが変わり続けるなら、上書きせずに io を返す", async () => {
    await applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 });
    let count = 0;
    const result = await applyDiagramNoteOp(
      wt,
      REL,
      { type: "move", id: "n1", x: 50, y: 50 },
      undefined,
      () => {
        const file = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
        file.notes.push({
          id: `c${count++}`,
          author: "claude",
          text: "",
          x: 0,
          y: 0,
        });
        fs.writeFileSync(notesFile(), JSON.stringify(file, null, 2));
      }
    );
    expect(result).toEqual({ ok: false, code: "io" });
    const file = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    expect(file.notes.map((note: { id: string }) => note.id)).toEqual([
      "n1",
      "c0",
      "c1",
      "c2",
    ]);
    expect(file.notes[0]).toMatchObject({ x: 0, y: 0 });
    // 一時ファイルを残さない
    expect(
      fs.readdirSync(dir).filter(name => name.includes("ark-tmp"))
    ).toEqual([]);
  });

  it("読み飛ばした付箋があるファイルには書かない (書くと、読み飛ばしたものが消える)", async () => {
    const broken = JSON.stringify({
      notes: [
        { id: "n1", author: "human", text: "人", x: 0, y: 0 },
        { id: 7, author: "claude", text: "idが数", x: 200, y: 0 },
      ],
    });
    fs.writeFileSync(notesFile(), broken);
    await expect(readDiagramNotes(wt, REL)).resolves.toMatchObject({
      ok: true,
      dropped: 1,
    });
    await expect(
      applyDiagramNoteOp(wt, REL, { type: "move", id: "n1", x: 9, y: 9 })
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expect(fs.readFileSync(notesFile(), "utf8")).toBe(broken);
  });

  it("続けて来た操作を、どれも落とさずに順に当てる", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        applyDiagramNoteOp(wt, REL, { type: "add", id: `n${i}`, x: i, y: 0 })
      )
    );
    const result = await readDiagramNotes(wt, REL);
    expect(result.ok && result.notes.notes).toHaveLength(12);
  });

  it("JSON として読めないファイルには書かず、invalid を返す", async () => {
    fs.writeFileSync(notesFile(), "{ 壊れた");
    await expect(readDiagramNotes(wt, REL)).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    await expect(
      applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 })
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expect(fs.readFileSync(notesFile(), "utf8")).toBe("{ 壊れた");
  });

  it("付箋のファイルがシンボリックリンクなら、指す先を読まない", async () => {
    const outside = path.join(wt, "secret.json");
    fs.writeFileSync(outside, '{"notes":[]}');
    fs.symlinkSync(outside, notesFile());
    await expect(readDiagramNotes(wt, REL)).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    await expect(
      applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 })
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(fs.readFileSync(outside, "utf8")).toBe('{"notes":[]}');
  });

  it("置き場所のディレクトリが worktree の外を指していたら、読み書きしない", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ark-notes-out-"));
    try {
      fs.rmSync(dir, { recursive: true });
      fs.symlinkSync(outside, dir);
      await expect(
        applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 })
      ).resolves.toEqual({ ok: false, code: "forbidden" });
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("図のパスが不正なら forbidden", async () => {
    await expect(
      readDiagramNotes(wt, "../outside.diagram.html")
    ).resolves.toEqual({ ok: false, code: "forbidden" });
  });

  it("図を消すときに付箋のファイルも消す。無くても失敗しない", async () => {
    await applyDiagramNoteOp(wt, REL, { type: "add", id: "n1", x: 0, y: 0 });
    await removeDiagramNotes(wt, REL);
    expect(fs.existsSync(notesFile())).toBe(false);
    await expect(removeDiagramNotes(wt, REL)).resolves.toBeUndefined();
  });
});
