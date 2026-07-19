/**
 * 簡略スキーマ（board_write の入力）→ 正規 Excalidraw 要素への変換（純ロジック）。
 * Phase A の簡略化:
 *  - シェイプの text ラベルは containerId バインドではなく、中央寄せの独立 text 要素にする。
 *  - arrow の from/to は「同一バッチ内のシェイプ id」を解決する（既存 scene への横断参照は Phase C）。
 */

export type SimpleShape = {
  type: "rect" | "ellipse" | "diamond";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  color?: string;
};
export type SimpleText = {
  type: "text";
  id: string;
  x: number;
  y: number;
  text: string;
  color?: string;
};
export type SimpleArrow = {
  type: "arrow";
  id: string;
  from: string;
  to: string;
  label?: string;
};
export type SimpleElement = SimpleShape | SimpleText | SimpleArrow;

export type ExcalidrawElement = Record<string, unknown>;

const SHAPE_TYPE_MAP: Record<string, string> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
};

/**
 * fractional index。Phase A は "a" + ゼロ埋め連番で十分（厳密な fractional-indexing は不要）。
 * ゼロ埋めにより辞書順=数値順を保証する（"a0010" > "a0002"。padStart 無しだと "a10" < "a2"）。
 */
function fractionalIndex(n: number): string {
  return `a${String(n).padStart(4, "0")}`;
}

/** Excalidraw 要素の共通必須フィールドを埋める。 */
function baseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
  rng: () => number,
  strokeColor: string
): ExcalidrawElement {
  const seed = Math.floor(rng() * 2 ** 31);
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed,
    version: 1,
    versionNonce: Math.floor(rng() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/** シェイプ中央に置く独立 text 要素を作る（Phase A: container バインドしない）。 */
function centeredText(
  id: string,
  cx: number,
  cy: number,
  text: string,
  index: string,
  rng: () => number,
  strokeColor: string
): ExcalidrawElement {
  const fontSize = 20;
  // 概算幅（等幅前提の粗い見積り。厳密なメトリクスは不要）
  const width = text.length * 6;
  const height = fontSize * 1.25;
  return {
    ...baseElement(
      id,
      "text",
      cx - width / 2,
      cy - height / 2,
      width,
      height,
      index,
      rng,
      strokeColor
    ),
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    baseline: fontSize,
    roundness: null,
  };
}

export function expandElements(
  simple: SimpleElement[],
  opts: { startIndex: number; rng?: () => number }
): {
  elements: ExcalidrawElement[];
  skipped: { id?: string; reason: string }[];
} {
  const rng = opts.rng ?? Math.random;
  const strokeDefault = "#1e1e1e";
  const elements: ExcalidrawElement[] = [];
  const skipped: { id?: string; reason: string }[] = [];
  // arrow 解決用: バッチ内シェイプの矩形を id で引く
  const shapeBox = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  let idx = opts.startIndex;

  // 1 パス目: シェイプを展開して shapeBox を作る
  for (const el of simple) {
    if (el.type === "rect" || el.type === "ellipse" || el.type === "diamond") {
      const exType = SHAPE_TYPE_MAP[el.type];
      elements.push(
        baseElement(
          el.id,
          exType,
          el.x,
          el.y,
          el.w,
          el.h,
          fractionalIndex(idx++),
          rng,
          el.color ?? strokeDefault
        )
      );
      shapeBox.set(el.id, { x: el.x, y: el.y, w: el.w, h: el.h });
      if (el.text) {
        elements.push(
          centeredText(
            `${el.id}__label`,
            el.x + el.w / 2,
            el.y + el.h / 2,
            el.text,
            fractionalIndex(idx++),
            rng,
            el.color ?? strokeDefault
          )
        );
      }
    }
  }

  // 2 パス目: 全要素を順序通りに処理（text, arrow, 未知型）
  for (const el of simple) {
    if (el.type === "rect" || el.type === "ellipse" || el.type === "diamond") {
      // already processed in pass 1
    } else if (el.type === "text") {
      elements.push(
        baseElement(
          el.id,
          "text",
          el.x,
          el.y,
          el.text.length * 6,
          25,
          fractionalIndex(idx++),
          rng,
          el.color ?? strokeDefault
        )
      );
      // text 固有フィールドを付与
      const t = elements[elements.length - 1] as Record<string, unknown>;
      Object.assign(t, {
        text: el.text,
        originalText: el.text,
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
        baseline: 20,
        roundness: null,
      });
    } else if (el.type === "arrow") {
      const from = shapeBox.get(el.from);
      const to = shapeBox.get(el.to);
      if (!from || !to) {
        skipped.push({
          id: el.id,
          reason: `arrow の from/to を解決できません（from=${el.from}, to=${el.to}）`,
        });
        continue;
      }
      const fx = from.x + from.w / 2;
      const fy = from.y + from.h / 2;
      const tx = to.x + to.w / 2;
      const ty = to.y + to.h / 2;
      const arrow: ExcalidrawElement = {
        // width/height は絶対値（左向き/上向き矢印で負値にならないよう）。points は符号付きで方向を表す
        ...baseElement(
          el.id,
          "arrow",
          fx,
          fy,
          Math.abs(tx - fx),
          Math.abs(ty - fy),
          fractionalIndex(idx++),
          rng,
          strokeDefault
        ),
        points: [
          [0, 0],
          [tx - fx, ty - fy],
        ],
        lastCommittedPoint: null,
        startBinding: { elementId: el.from, focus: 0, gap: 4 },
        endBinding: { elementId: el.to, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
        roundness: { type: 2 },
      };
      elements.push(arrow);
      // label があれば矢印の中点に中央寄せ text 要素を追加する（index を1つ消費）
      if (el.label) {
        elements.push(
          centeredText(
            `${el.id}__label`,
            (fx + tx) / 2,
            (fy + ty) / 2,
            el.label,
            fractionalIndex(idx++),
            rng,
            strokeDefault
          )
        );
      }
    } else {
      skipped.push({
        id: (el as { id?: string }).id,
        reason: `unknown type: ${(el as { type?: string }).type}`,
      });
    }
  }

  return { elements, skipped };
}
