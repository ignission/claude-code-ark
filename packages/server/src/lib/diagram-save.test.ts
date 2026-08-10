import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractModel } from "./diagram-file.js";
import type { DiagramModel } from "./diagram-model.js";
import { DIAGRAM_DIR } from "./diagram-path.js";
import { saveDiagramEdit } from "./diagram-save.js";

const initialModel: DiagramModel = {
  version: 1,
  nodes: [{ id: "order", label: "Order" }],
  edges: [],
  groups: [],
};

const html = (model: DiagramModel, label = model.nodes[0]?.label ?? "") =>
  `<html><body><script type="application/json" id="ark-diagram-model">${JSON.stringify(model)}</script><h1>${label}</h1></body></html>`;

let worktree: string;
let absPath: string;

beforeEach(() => {
  worktree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-save-"))
  );
  const directory = path.join(worktree, DIAGRAM_DIR);
  fs.mkdirSync(directory, { recursive: true });
  absPath = path.join(directory, "sample.diagram.html");
  fs.writeFileSync(absPath, `<!doctype html>\n${html(initialModel, "Order")}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe("saveDiagramEdit", () => {
  it("検証済みモデルへブロックを差し替え、保存前モデルも返す", async () => {
    const edited: DiagramModel = {
      ...initialModel,
      nodes: [{ id: "order", label: "Edited Order" }],
    };
    const beforeWrite: string[] = [];

    const result = await saveDiagramEdit(
      worktree,
      "sample.diagram.html",
      edited,
      html(initialModel, "Edited Order"),
      path => beforeWrite.push(path)
    );

    expect(result).toMatchObject({
      ok: true,
      previousModel: initialModel,
      savedModel: edited,
    });
    expect(beforeWrite).toEqual([absPath]);
    const savedHtml = fs.readFileSync(absPath, "utf8");
    expect(savedHtml).toMatch(/^<!doctype html>/i);
    expect(extractModel(savedHtml)).toEqual({ ok: true, model: edited });
    expect(savedHtml).toContain("<h1>Edited Order</h1>");
  });

  it("不正モデルは保存せず、beforeWrite も呼ばない", async () => {
    const original = fs.readFileSync(absPath, "utf8");
    let beforeWriteCalled = false;

    const result = await saveDiagramEdit(
      worktree,
      "sample.diagram.html",
      { version: 2 },
      html(initialModel),
      () => {
        beforeWriteCalled = true;
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "version は 1 である必要があります",
    });
    expect(beforeWriteCalled).toBe(false);
    expect(fs.readFileSync(absPath, "utf8")).toBe(original);
  });

  it.each([
    {
      name: "anchor がない",
      projection: "<main><p>本文</p></main>",
      expectedId: "section-1",
    },
    {
      name: "anchor が重複する",
      projection:
        '<main data-ark-id="section-1"><p data-ark-id="section-1">本文</p></main>',
      expectedId: "section-1",
    },
    {
      name: "未知の anchor がある",
      projection:
        '<main data-ark-id="section-1"><p data-ark-id="unknown">本文</p></main>',
      expectedId: "unknown",
    },
  ])("doc の $name 場合は元ファイルを変更しない", async testCase => {
    const original = fs.readFileSync(absPath, "utf8");
    const docModel: DiagramModel = {
      version: 1,
      type: "doc",
      nodes: [{ id: "section-1", label: "概要" }],
      edges: [],
      groups: [],
    };
    let beforeWriteCalled = false;

    const result = await saveDiagramEdit(
      worktree,
      "sample.diagram.html",
      docModel,
      `<html><body><script type="application/json" id="ark-diagram-model">${JSON.stringify(initialModel)}</script>${testCase.projection}</body></html>`,
      () => {
        beforeWriteCalled = true;
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(testCase.expectedId);
    expect(beforeWriteCalled).toBe(false);
    expect(fs.readFileSync(absPath, "utf8")).toBe(original);
  });

  it("write が失敗しても元ファイルを空にしない", async () => {
    const original = fs.readFileSync(absPath, "utf8");
    const open = fs.promises.open.bind(fs.promises);
    const close = vi.fn();

    await expect(
      saveDiagramEdit(
        worktree,
        "sample.diagram.html",
        initialModel,
        html(initialModel, "Updated"),
        () => {
          vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            close.mockImplementation(() => handle.close());
            return {
              write: vi.fn().mockRejectedValue(new Error("write failed")),
              truncate: vi.fn(),
              close,
            } as unknown as fs.promises.FileHandle;
          });
        }
      )
    ).rejects.toThrow("write failed");

    expect(close).toHaveBeenCalledOnce();
    expect(fs.readFileSync(absPath, "utf8")).toBe(original);
    expect(fs.statSync(absPath).size).toBe(Buffer.byteLength(original));
  });
});
