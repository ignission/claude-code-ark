/**
 * mermaid コード → Excalidraw 要素への変換。
 *
 * - 対応図種 (flowchart / sequence / class): parseMermaidToExcalidraw で
 *   skeleton を得て convertToExcalidrawElements で実要素化する（編集可能）
 * - 未対応図種: 既存の renderMermaidToSvg で SVG に描画し、画像要素として
 *   ボードに置く（編集不可だが周囲に付箋は置ける）
 *
 * ライブラリ関数は DI（BoardConversionDeps）で注入する。env=node の vitest
 * では DOM 依存の実ライブラリが動かないため、テストは fake deps で行い、
 * 実配線（defaultDeps）は E2E で検証する。
 */
import { renderMermaidToSvg } from "./mermaid-block-utils";

export interface BoardConversionDeps {
  parse(code: string): Promise<{
    elements: unknown[];
    files?: Record<string, unknown>;
  }>;
  convert(skeleton: unknown[]): unknown[];
  renderSvg(
    code: string,
    id: string
  ): Promise<{ ok: true; svg: string } | { ok: false; error: string }>;
}

let convSeq = 0;

async function loadDefaultDeps(): Promise<BoardConversionDeps> {
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] =
    await Promise.all([
      import("@excalidraw/mermaid-to-excalidraw"),
      import("@excalidraw/excalidraw"),
    ]);
  return {
    parse: code => parseMermaidToExcalidraw(code),
    convert: skeleton =>
      // ライブラリの skeleton 型はここでは不問（実要素化のみ担う）
      convertToExcalidrawElements(
        skeleton as Parameters<typeof convertToExcalidrawElements>[0]
      ) as unknown[],
    renderSvg: renderMermaidToSvg,
  };
}

/**
 * UTF-8 バイト列を base64 化する。
 * スプレッド演算子の引数上限（約 65,536）を避けるためチャンク処理を行い、
 * 巨大な SVG での RangeError を防ぐ。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** SVG 文字列から width/height を抽出（無ければ既定値） */
function svgSize(svg: string): { width: number; height: number } {
  const w = /\bwidth="([\d.]+)/.exec(svg);
  const h = /\bheight="([\d.]+)/.exec(svg);
  return {
    width: w ? Math.min(Number(w[1]), 800) : 600,
    height: h ? Math.min(Number(h[1]), 800) : 400,
  };
}

export async function convertMermaidForBoard(
  code: string,
  deps?: BoardConversionDeps
): Promise<{
  elements: unknown[];
  files: Record<string, unknown>;
  fallback: boolean;
}> {
  const d = deps ?? (await loadDefaultDeps());
  try {
    const parsed = await d.parse(code);
    return {
      elements: d.convert(parsed.elements),
      files: parsed.files ?? {},
      fallback: false,
    };
  } catch (error) {
    // 未対応図種は正常なフォールバック経路だが、convert 側の実バグが
    // 同じ経路に紛れると調査不能になるため、元エラーは必ずログに残す
    console.warn(
      "mermaid→Excalidraw 変換に失敗。SVG 画像でフォールバックします:",
      error
    );
    // SVG 画像フォールバック
    const rendered = await d.renderSvg(code, `mmd-board-${(convSeq += 1)}`);
    if (!rendered.ok) {
      throw new Error(rendered.error);
    }
    const { width, height } = svgSize(rendered.svg);
    const fileId = `board-svg-${Date.now()}-${convSeq}`;
    const base64 = bytesToBase64(new TextEncoder().encode(rendered.svg));
    const files: Record<string, unknown> = {
      [fileId]: {
        id: fileId,
        mimeType: "image/svg+xml",
        dataURL: `data:image/svg+xml;base64,${base64}`,
        created: Date.now(),
      },
    };
    const imageSkeleton = {
      type: "image",
      fileId,
      x: 0,
      y: 0,
      width,
      height,
    };
    // 成功パスと同じく convertToExcalidrawElements を通し、id/seed/version 等を
    // Excalidraw に補完させる（手組みの skeleton のままだと要素として不完全）
    return { elements: d.convert([imageSkeleton]), files, fallback: true };
  }
}

/** 既存要素の右端 + padding を新規挿入の X オフセットとして返す */
export function computeInsertOffset(
  existing: Array<{ x: number; width: number }>,
  padding = 80
): number {
  if (existing.length === 0) return 0;
  const rightEdge = Math.max(...existing.map(el => el.x + el.width));
  return rightEdge + padding;
}
