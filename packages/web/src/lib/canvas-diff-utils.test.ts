import { describe, expect, it } from "vitest";
import { type BoardElementLike, buildBoardDiffText } from "./canvas-diff-utils";

function rect(
  id: string,
  x: number,
  y: number,
  overrides: Partial<BoardElementLike> = {}
): BoardElementLike {
  return { id, type: "rectangle", x, y, width: 120, height: 60, ...overrides };
}

/** container に紐づくラベルテキスト要素 */
function boundText(
  id: string,
  containerId: string,
  text: string
): BoardElementLike {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    text,
    containerId,
  };
}

/** 独立した付箋テキスト */
function note(
  id: string,
  x: number,
  y: number,
  text: string
): BoardElementLike {
  return { id, type: "text", x, y, width: 150, height: 24, text };
}

describe("buildBoardDiffText", () => {
  it("変更なしなら空文字列を返す", () => {
    const els = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    expect(buildBoardDiffText(els, els)).toBe("");
  });

  it("付箋の追加を近接要素つきで整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    const next = [...prev, note("n1", 150, 30, "認証は Phase 2 に回す")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("[ボード更新]");
    expect(text).toContain(
      "追加: 付箋「認証は Phase 2 に回す」（「ログイン機能」の近く）"
    );
  });

  it("遠い要素は近接表記なしで整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    const next = [...prev, note("n1", 5000, 5000, "遠い付箋")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("追加: 付箋「遠い付箋」");
    expect(text).not.toContain("遠い付箋」（");
  });

  it("矢印の追加を接続先ラベルで整形する", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 400, 0);
    const prev = [
      a,
      b,
      boundText("a-t", "a", "セッション管理"),
      boundText("b-t", "b", "Redis 検討"),
    ];
    const arrow: BoardElementLike = {
      id: "ar1",
      type: "arrow",
      x: 120,
      y: 30,
      width: 280,
      height: 0,
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    };
    const text = buildBoardDiffText(prev, [...prev, arrow]);
    expect(text).toContain("追加: 矢印「セッション管理」→「Redis 検討」");
  });

  it("テキスト変更を before → after で整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "API 設計")];
    const next = [
      rect("a", 0, 0),
      boundText("a-t", "a", "API 設計 (REST で確定)"),
    ];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain(
      "変更: カード「API 設計」→「API 設計 (REST で確定)」"
    );
  });

  it("削除を整形する", () => {
    const prev = [
      rect("a", 0, 0),
      boundText("a-t", "a", "x"),
      note("n1", 0, 200, "GraphQL 案"),
    ];
    const next = [rect("a", 0, 0), boundText("a-t", "a", "x")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("削除: 付箋「GraphQL 案」");
  });

  it("isDeleted=true の要素は削除扱いになる", () => {
    const prev = [note("n1", 0, 0, "消える付箋")];
    const next = [{ ...note("n1", 0, 0, "消える付箋"), isDeleted: true }];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("削除: 付箋「消える付箋」");
  });

  it("座標の生値を出力に含めない", () => {
    const prev: BoardElementLike[] = [];
    const next = [note("n1", 1234, 5678, "付箋A")];
    const text = buildBoardDiffText(prev, next);
    expect(text).not.toContain("1234");
    expect(text).not.toContain("5678");
  });

  it("要素が残ったままラベルだけ消えた場合も変更として整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "API 設計")];
    const next = [
      rect("a", 0, 0),
      { ...boundText("a-t", "a", "API 設計"), isDeleted: true },
    ];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("変更: カード「API 設計」→（ラベル削除）");
  });
});
