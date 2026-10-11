/**
 * 配信中の Web UI が、いま動いている版より新しいかを確かめて読み込み直す。
 *
 * ホーム画面に置いたアプリは、背面から戻っても読み込み済みのページを使い続け、
 * 再読み込みのボタンも無い。サーバーだけがデプロイで新しくなると、古い画面が
 * 新しいサーバーと話し続け、イベントの形が変わった版では表示が食い違う。
 *
 * 版の目印は、ビルドのたびに `vite.config.ts` が index.html へ入れる
 * `<meta name="ark-build">`。再接続したときに index.html を取り直して比べる
 * (デプロイはサーバーの再起動を伴うので、開いていた画面は必ず再接続を通る)。
 *
 * 勝手に読み込み直すと困る場面が2つあり、どちらも避ける。
 *
 * - 書きかけの入力がある: 下書きは保存していないので消える。読み込み直さず、
 *   利用者に知らせて任せる
 * - 読み込み直しても版が変わらない (index.html が手前でキャッシュされている等):
 *   同じ版へは一度しか読み込み直さない。繰り返すと画面が開けなくなる
 */

export const BUILD_META_NAME = "ark-build";

const BUILD_META_PATTERN = new RegExp(
  `<meta[^>]*name="${BUILD_META_NAME}"[^>]*content="([^"]+)"`
);
const RELOAD_TARGET_KEY = "ark-build-reload-target";

export type BuildUpdateAction = "none" | "reload" | "prompt";

export interface BuildUpdateInput {
  /** いま動いている版。目印の無いページ (古いビルド) では null */
  current: string | null;
  /** サーバーがいま配っている版。取得できなかったら null */
  served: string | null;
  /** このタブが直前に読み込み直しで目指した版 */
  lastReloadTarget: string | null;
  /** 書きかけの入力があるか */
  hasUnsavedInput: boolean;
}

export function parseBuildId(html: string): string | null {
  return BUILD_META_PATTERN.exec(html)?.[1] ?? null;
}

export function decideBuildUpdate(input: BuildUpdateInput): BuildUpdateAction {
  const { current, served } = input;
  // どちらかが分からないときは動かない (取得の失敗を新しい版と読み違えない)
  if (!current || !served || current === served) return "none";
  if (served === input.lastReloadTarget) return "none";
  return input.hasUnsavedInput ? "prompt" : "reload";
}

export function currentBuildId(): string | null {
  return (
    document
      .querySelector(`meta[name="${BUILD_META_NAME}"]`)
      ?.getAttribute("content") ?? null
  );
}

/** いま開いている URL の index.html を取り直して、配信中の版を読む */
export async function fetchServedBuildId(): Promise<string | null> {
  try {
    const res = await fetch(window.location.href, { cache: "no-store" });
    // Cloudflare Access のログイン切れは別オリジンへの転送になる。
    // そのページを Ark の index.html として読まない
    if (!res.ok || new URL(res.url).origin !== window.location.origin) {
      return null;
    }
    return parseBuildId(await res.text());
  } catch {
    return null;
  }
}

/**
 * 書きかけの入力があるか。入力欄に文字があるか、ファイルの編集画面に
 * 未保存の変更があれば、あるとみなす (編集画面は `data-ark-unsaved` で知らせる)
 */
export function hasUnsavedInput(): boolean {
  const fields = document.querySelectorAll<
    HTMLTextAreaElement | HTMLInputElement
  >('textarea, input[type="text"], input:not([type])');
  for (const field of Array.from(fields)) {
    if (field.value.trim() !== "") return true;
  }
  return document.querySelector('[data-ark-unsaved="true"]') !== null;
}

export function readReloadTarget(): string | null {
  try {
    return window.sessionStorage.getItem(RELOAD_TARGET_KEY);
  } catch {
    return null;
  }
}

/** 目指す版を記録してから読み込み直す (同じ版へ二度読み込み直さないため) */
export function reloadForBuild(served: string): void {
  try {
    window.sessionStorage.setItem(RELOAD_TARGET_KEY, served);
  } catch {
    // 記録できないと繰り返しを止められないので、読み込み直さない
    return;
  }
  window.location.reload();
}
