/**
 * BoardMcpServer の純ロジック部（BoardSessionRegistry / handleBoardWrite）のユニットテスト。
 * HTTP transport 配線は ark-mcp-server.ts と同構造のため、ここでは純ロジックのみ検証する。
 */

import { describe, expect, it, vi } from "vitest";
import {
  BoardSessionRegistry,
  handleBoardOpen,
  handleBoardWrite,
} from "./board-mcp-server.js";

describe("BoardSessionRegistry", () => {
  it("register/resolve/unregister が機能する", () => {
    const r = new BoardSessionRegistry();
    r.register("tok1", "/wt/a");
    expect(r.resolve("tok1")).toBe("/wt/a");
    r.unregister("tok1");
    expect(r.resolve("tok1")).toBeNull();
    expect(r.resolve("unknown")).toBeNull();
  });
});

describe("handleBoardWrite", () => {
  const makeDeps = (initial: unknown[] = []) => {
    let scene = { elements: initial };
    return {
      getBoardScene: vi.fn(() => scene),
      saveBoardScene: vi.fn((_wt: string, s: { elements: unknown[] }) => {
        scene = s;
      }),
      notifyUpdated: vi.fn(),
      current: () => scene,
    };
  };

  it("append: 既存に要素を追加し canvas を通知する", () => {
    const deps = makeDeps([{ id: "old", type: "rectangle", index: "a0" }]);
    const res = handleBoardWrite(deps, "/wt/a", {
      mode: "append",
      elements: [{ type: "rect", id: "r1", x: 0, y: 0, w: 10, h: 10 }],
    });
    expect(deps.current().elements).toHaveLength(2);
    expect(deps.notifyUpdated).toHaveBeenCalledWith("/wt/a");
    expect(res.added).toBe(1);
    expect(res.total).toBe(2);
  });

  it("replace: 既存を破棄して置換する", () => {
    const deps = makeDeps([{ id: "old", type: "rectangle", index: "a0" }]);
    handleBoardWrite(deps, "/wt/a", {
      mode: "replace",
      elements: [{ type: "text", id: "t1", x: 0, y: 0, text: "hi" }],
    });
    expect(deps.current().elements).toHaveLength(1);
    expect((deps.current().elements[0] as Record<string, unknown>).id).toBe(
      "t1"
    );
  });

  it("無効要素は skip し、返り値に含める（scene は壊さない）", () => {
    const deps = makeDeps([]);
    const res = handleBoardWrite(deps, "/wt/a", {
      mode: "append",
      elements: [{ type: "arrow", id: "bad", from: "x", to: "y" }],
    });
    expect(res.added).toBe(0);
    expect(res.skipped.length).toBe(1);
    // 有効要素ゼロなら保存も通知もしない
    expect(deps.saveBoardScene).not.toHaveBeenCalled();
    expect(deps.notifyUpdated).not.toHaveBeenCalled();
  });
});

describe("handleBoardOpen", () => {
  it("deps.openDiagram に worktreePath と相対パスを渡す", () => {
    const openDiagram = vi.fn(() => ({ ok: true }));
    const deps = { openDiagram } as never;

    const res = handleBoardOpen(deps, "/wt", {
      path: "docs/diagrams/a.diagram.html",
    });

    expect(openDiagram).toHaveBeenCalledWith(
      "/wt",
      "docs/diagrams/a.diagram.html"
    );
    expect(res.ok).toBe(true);
  });

  it("deps がエラーを返したらそのまま伝える", () => {
    const deps = {
      openDiagram: vi.fn(() => ({ ok: false, error: "見つかりません" })),
    } as never;

    const res = handleBoardOpen(deps, "/wt", { path: "a.diagram.html" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("見つかりません");
  });
});
