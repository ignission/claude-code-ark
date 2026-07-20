import { describe, expect, it } from "vitest";
import { describeModelDiff } from "./diagram-diff.js";
import type { DiagramModel } from "./diagram-model.js";

function model(
  nodes: DiagramModel["nodes"],
  edges: DiagramModel["edges"] = []
): DiagramModel {
  return { version: 1, nodes, edges, groups: [] };
}

const order = {
  id: "order",
  label: "Order",
  fields: [
    { id: "f_id", label: "id" },
    { id: "f_status", label: "status" },
  ],
};

describe("describeModelDiff", () => {
  it("フィールドの追加を述べる", () => {
    const after = model([
      {
        ...order,
        fields: [
          ...(order.fields ?? []),
          { id: "f_cancelled", label: "cancelled_at" },
        ],
      },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order に cancelled_at を追加",
    ]);
  });

  it("フィールドの削除を述べる", () => {
    const after = model([{ ...order, fields: [{ id: "f_id", label: "id" }] }]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order から status を削除",
    ]);
  });

  it("フィールドの改名を述べる", () => {
    const after = model([
      {
        ...order,
        fields: [
          { id: "f_id", label: "id" },
          { id: "f_status", label: "state" },
        ],
      },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order の status を state に変更",
    ]);
  });

  it("フィールドの並べ替えを述べる", () => {
    const after = model([
      {
        ...order,
        fields: [
          { id: "f_status", label: "status" },
          { id: "f_id", label: "id" },
        ],
      },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order のフィールド順を status, id に変更",
    ]);
  });

  it("ノードの追加と削除を述べる", () => {
    const user = { id: "user", label: "User" };

    expect(describeModelDiff(model([order]), model([order, user]))).toEqual([
      "User を追加",
    ]);
    expect(describeModelDiff(model([order, user]), model([order]))).toEqual([
      "User を削除",
    ]);
  });

  it("関連の追加を述べる", () => {
    const user = { id: "user", label: "User" };
    const before = model([order, user]);
    const after = model(
      [order, user],
      [{ id: "e1", from: "order", to: "user", label: "belongs to" }]
    );

    expect(describeModelDiff(before, after)).toEqual([
      "Order から User への関連「belongs to」を追加",
    ]);
  });

  it("変更が無ければ空配列を返す", () => {
    expect(describeModelDiff(model([order]), model([order]))).toEqual([]);
  });

  it("複数の変更を並べる", () => {
    const after = model([
      {
        ...order,
        fields: [
          ...(order.fields ?? []),
          { id: "f_cancelled", label: "cancelled_at" },
        ],
      },
      { id: "user", label: "User" },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order に cancelled_at を追加",
      "User を追加",
    ]);
  });
});

describe("describeModelDiff（境界ケース）", () => {
  it("空のモデル同士では空配列を返す", () => {
    expect(describeModelDiff(model([]), model([]))).toEqual([]);
  });

  it("片方が空のモデルでもノード追加/削除として述べる", () => {
    expect(describeModelDiff(model([]), model([order]))).toEqual([
      "Order を追加",
    ]);
    expect(describeModelDiff(model([order]), model([]))).toEqual([
      "Order を削除",
    ]);
  });

  it("ノードの改名とフィールド変更が同時に起きたとき、改名を先に述べる", () => {
    const before = {
      id: "order",
      label: "Order",
      fields: [{ id: "f_id", label: "id" }],
    };
    const after = {
      id: "order",
      label: "Purchase",
      fields: [{ id: "f_id", label: "identifier" }],
    };

    expect(describeModelDiff(model([before]), model([after]))).toEqual([
      "Order を Purchase に改名",
      "Purchase の id を identifier に変更",
    ]);
  });

  it("新規ノードにフィールドがあっても、ノード追加とは別にフィールド追加文を出さない", () => {
    const user = {
      id: "user",
      label: "User",
      fields: [
        { id: "f_name", label: "name" },
        { id: "f_email", label: "email" },
      ],
    };

    expect(describeModelDiff(model([]), model([user]))).toEqual([
      "User を追加",
    ]);
  });

  it("削除されるノードのフィールドについては個別のフィールド削除文を出さない", () => {
    expect(describeModelDiff(model([order]), model([]))).toEqual([
      "Order を削除",
    ]);
  });

  it("edge の to が変わったとき、変更前後を明示して述べる", () => {
    const user = { id: "user", label: "User" };
    const product = { id: "product", label: "Product" };
    const nodes = [order, user, product];
    const before = model(nodes, [
      { id: "e1", from: "order", to: "user", label: "ships to" },
    ]);
    const after = model(nodes, [
      { id: "e1", from: "order", to: "product", label: "ships to" },
    ]);

    expect(describeModelDiff(before, after)).toEqual([
      "Order から User への関連「ships to」を Order から Product への関連「ships to」 に変更",
    ]);
  });

  it("削除されるノードとそれを参照するedgeが同時に消えたとき、edge文の主語はbefore側のノードlabelを使う", () => {
    const user = { id: "user", label: "User" };
    const before = model(
      [order, user],
      [{ id: "e1", from: "order", to: "user", label: "owns" }]
    );
    const after = model([order]);

    expect(describeModelDiff(before, after)).toEqual([
      "User を削除",
      "Order から User への関連「owns」を削除",
    ]);
  });

  it("フィールドの追加と削除が同時に起きても、残存フィールドが1件以下なら並べ替えとして扱わない", () => {
    const after = model([
      {
        ...order,
        fields: [
          { id: "f_id", label: "id" },
          { id: "f_cancelled", label: "cancelled_at" },
        ],
      },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order に cancelled_at を追加",
      "Order から status を削除",
    ]);
  });

  it("group の変更はコア対象外なので無視される", () => {
    const before: DiagramModel = {
      version: 1,
      nodes: [order],
      edges: [],
      groups: [],
    };
    const after: DiagramModel = {
      version: 1,
      nodes: [order],
      edges: [],
      groups: [{ id: "g1", label: "集約", nodes: ["order"] }],
    };

    expect(describeModelDiff(before, after)).toEqual([]);
  });

  it("kind / ext の変更はサーバーが解釈しない要素なので無視される", () => {
    const before = {
      id: "order",
      label: "Order",
      kind: "entity",
      ext: { color: "red" },
    };
    const after = {
      id: "order",
      label: "Order",
      kind: "aggregate",
      ext: { color: "blue" },
    };

    expect(describeModelDiff(model([before]), model([after]))).toEqual([]);
  });

  it("label に「」や改行を含んでいてもエスケープせずそのまま埋め込む", () => {
    const after = model([
      {
        ...order,
        fields: [
          ...(order.fields ?? []),
          { id: "f_note", label: "備考「重要」\n要確認" },
        ],
      },
    ]);

    expect(describeModelDiff(model([order]), after)).toEqual([
      "Order に 備考「重要」\n要確認 を追加",
    ]);
  });
});
