/**
 * PCサイドバー (SidebarMainLayout) の幅の上限を決める。
 *
 * 上限は「450px」だけでは足りない。メインペイン (SplitViewPane) には、上部バー
 * (主ラベル・状態チップ・1タップの操作・`…`) と、会話に重ねる端末の窓 (最小の幅480px。
 * FloatingTerminal) が入る。860pxのウィンドウで450pxのサイドバーを許すと、
 * メインペインは386pxしか残らず、端末の窓が最小の幅を取れない。
 *
 * そこで「ウィンドウ幅 − パネルの外の余白とすき間 − メインペインの最低幅」でも
 * 頭打ちにする。
 */

export const SIDEBAR_MIN_WIDTH = 180;
/** これまでの上限。広いウィンドウではこれが効く */
export const SIDEBAR_MAX_WIDTH = 450;
export const SIDEBAR_DEFAULT_WIDTH = 300;

/**
 * メインペインに必ず残す幅。
 *
 * 端末の窓の最小の幅 (480px。FloatingTerminal) を取れる幅。上部バーの操作
 * (ショートカット・パネル・`…`) と状態チップも、この幅なら1段に並ぶ。
 */
export const MAIN_PANE_MIN_WIDTH = 480;

/** 壁紙の余白 (`p-2`)。サイドバーとメインペインの外側の左右に付く */
export const LAYOUT_PADDING_WIDTH = 8;
/** サイドバーとメインペインの間のすき間 (`gap-2`) */
export const LAYOUT_GAP_WIDTH = 8;
/** 2 枚のパネルの外に取られる幅 (左右の余白 + すき間) */
const LAYOUT_CHROME_WIDTH = LAYOUT_PADDING_WIDTH * 2 + LAYOUT_GAP_WIDTH;

/** このウィンドウ幅で許すサイドバーの最大幅 */
export function sidebarMaxWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return SIDEBAR_MAX_WIDTH;
  return Math.max(
    // PCレイアウトが出ない幅 (< 660px) まで来たら最低幅を優先する。
    // ここを下回らせると、サイドバー自体が読めなくなる
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      viewportWidth - LAYOUT_CHROME_WIDTH - MAIN_PANE_MIN_WIDTH
    )
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
