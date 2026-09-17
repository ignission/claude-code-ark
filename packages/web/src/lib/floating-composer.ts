/**
 * floating-composer - モバイルの浮かぶ入力バーの置き場所と、本文の下端に確保する余白。
 *
 * バーは本文コンテナの下端からFLOATING_BAR_BOTTOMだけ浮かせて絶対配置する。
 * 本文はバーの下を通るので、最下部までスクロールしたときに最後の行が隠れないよう
 * 「バーの実測の高さ + バーの下端からの距離 + 12px」の余白を本文の下端に取る。
 * 距離はenv(safe-area-inset-bottom) を含むのでpxに直さず、calcのままブラウザに解決させる
 */

/** 下端からの距離。ホームインジケータのある端末ではsafe areaの分だけ上げる */
export const FLOATING_BAR_BOTTOM = "max(12px, env(safe-area-inset-bottom))";

/** バーと本文の最後の行のあいだの余白 (px) */
const FLOATING_BAR_GAP_PX = 12;

/**
 * 本文の下端に確保する余白 (CSSの値)。
 * stackHeightPxはバー (と上に積んだカード) の実測の高さ
 */
export function floatingBarReserve(stackHeightPx: number): string {
  const height = Math.max(0, Math.ceil(stackHeightPx));
  return `calc(${height}px + ${FLOATING_BAR_BOTTOM} + ${FLOATING_BAR_GAP_PX}px)`;
}
