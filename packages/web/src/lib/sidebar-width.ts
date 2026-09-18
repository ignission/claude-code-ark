/**
 * PCサイドバー (SidebarMainLayout) の幅の上限を決める。
 *
 * 上限は「450px」だけでは足りない。メインペインの上部バー (SplitViewPane) は
 * 端末モードで1タップの操作が6つ並び、文言をアイコンに畳んだあとでも
 * 424px要る (実測)。860pxのウィンドウで450pxのサイドバーを許すと、
 * ペインの `overflow-hidden` に右端の `…` が切られ、通知と削除に到達できなくなる。
 *
 * そこで「ウィンドウ幅 − メインペインの最低幅」でも頭打ちにする。
 */

export const SIDEBAR_MIN_WIDTH = 180;
/** これまでの上限。広いウィンドウではこれが効く */
export const SIDEBAR_MAX_WIDTH = 450;
export const SIDEBAR_DEFAULT_WIDTH = 300;

/**
 * メインペインに必ず残す幅。
 *
 * 内訳は、上部バーが切り捨てなしに収まる幅 424px (端末モード・文言を畳んだ状態での
 * 実測値) + ペインの余白と枠線 18px (`p-3 pl-1` + 左右の border) = 442px に、
 * 左のまとまりに状態チップが残るぶん (チップ28px + 間隔10px) を足した値。
 */
export const MAIN_PANE_MIN_WIDTH = 480;

/** このウィンドウ幅で許すサイドバーの最大幅 */
export function sidebarMaxWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return SIDEBAR_MAX_WIDTH;
  return Math.max(
    // PCレイアウトが出ない幅 (< 660px) まで来たら最低幅を優先する。
    // ここを下回らせると、サイドバー自体が読めなくなる
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - MAIN_PANE_MIN_WIDTH)
  );
}

/** 保存値・ドラッグ位置・リサイズ後の幅を、このウィンドウ幅で許される値に丸める */
export function clampSidebarWidth(
  width: number,
  viewportWidth: number
): number {
  if (!Number.isFinite(width)) return SIDEBAR_MIN_WIDTH;
  return Math.min(
    sidebarMaxWidth(viewportWidth),
    Math.max(SIDEBAR_MIN_WIDTH, width)
  );
}
