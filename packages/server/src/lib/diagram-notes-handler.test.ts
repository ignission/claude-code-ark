import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDiagramNoteOp, readDiagramNotes } from "./diagram-notes.js";
import {
  blankBoardFileName,
  blankBoardHtml,
  handleDiagramCreate,
  handleDiagramNoteOp,
  handleDiagramNotesGet,
} from "./diagram-notes-handler.js";
import { readDiagram } from "./diagram-reader.js";

const REL = ".claude/diagrams/plan.diagram.html";
let wt: string;

beforeEach(() => {
  wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-notes-h-")));
});
afterEach(() => fs.rmSync(wt, { recursive: true, force: true }));

const deps = () => ({
  resolveManagedWorktreePath: (value: string) => (value === wt ? wt : null),
  readNotes: readDiagramNotes,
  applyOp: applyDiagramNoteOp,
});

describe("付箋の受け口", () => {
  it("管理外の worktree と形の合わない要求は forbidden", async () => {
    await expect(
      handleDiagramNotesGet(deps(), { worktreePath: "/etc", relPath: REL })
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    await expect(handleDiagramNotesGet(deps(), null)).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    await expect(
      handleDiagramNoteOp(deps(), {
        worktreePath: wt,
        relPath: REL,
        op: { type: "paint", id: "n1" },
      })
    ).resolves.toEqual({ ok: false, code: "forbidden" });
  });

  it("操作を保存し、読むと同じ付箋が返る", async () => {
    fs.mkdirSync(path.join(wt, ".claude/diagrams"), { recursive: true });
    const saved = await handleDiagramNoteOp(deps(), {
      worktreePath: wt,
      relPath: REL,
      op: { type: "add", id: "n1", x: 12, y: 34 },
      viewWidth: 1000,
    });
    expect(saved).toMatchObject({
      ok: true,
      notes: { notes: [{ id: "n1", author: "human", x: 12, y: 34 }] },
    });
    await expect(
      handleDiagramNotesGet(deps(), { worktreePath: wt, relPath: REL })
    ).resolves.toEqual(saved);
  });

  it("読み書きが投げても io で返す", async () => {
    const broken = {
      ...deps(),
      readNotes: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      handleDiagramNotesGet(broken, { worktreePath: wt, relPath: REL })
    ).resolves.toEqual({ ok: false, code: "io" });
  });
});

describe("白紙のボード", () => {
  const at = new Date(2026, 10, 14, 9, 5, 7);

  it("ファイル名は作った日時から付け、重なったら連番を足す", () => {
    expect(blankBoardFileName(at, 0)).toBe(
      "board-20261114-090507.diagram.html"
    );
    expect(blankBoardFileName(at, 1)).toBe(
      "board-20261114-090507-2.diagram.html"
    );
  });

  it("名前は title に入れ、HTML として解釈させない", () => {
    expect(blankBoardHtml("<b>&")).toContain("<title>&lt;b&gt;&amp;</title>");
  });

  it("ディレクトリが無くても作り、図として読める。同じ秒にもう1枚作れる", async () => {
    const first = await handleDiagramCreate(
      deps(),
      { worktreePath: wt, title: "ホワイトボード 11/14 09:05" },
      () => at
    );
    expect(first).toEqual({
      ok: true,
      relPath: ".claude/diagrams/board-20261114-090507.diagram.html",
    });
    const second = await handleDiagramCreate(
      deps(),
      { worktreePath: wt, title: "2枚目" },
      () => at
    );
    expect(second).toEqual({
      ok: true,
      relPath: ".claude/diagrams/board-20261114-090507-2.diagram.html",
    });
    if (!first.ok) return;
    const read = await readDiagram(wt, first.relPath);
    expect(read.ok && read.html).toContain(
      "<title>ホワイトボード 11/14 09:05</title>"
    );
  });

  it("図の置き場所が worktree の外を指していたら作らない", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ark-notes-out-"));
    try {
      fs.mkdirSync(path.join(wt, ".claude"));
      fs.symlinkSync(outside, path.join(wt, ".claude/diagrams"));
      const result = await handleDiagramCreate(
        deps(),
        { worktreePath: wt, title: "x" },
        () => at
      );
      expect(result.ok).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("管理外の worktree と形の合わない要求は断る", async () => {
    expect(
      (await handleDiagramCreate(deps(), { worktreePath: "/etc", title: "x" }))
        .ok
    ).toBe(false);
    expect((await handleDiagramCreate(deps(), { worktreePath: wt })).ok).toBe(
      false
    );
  });
});
