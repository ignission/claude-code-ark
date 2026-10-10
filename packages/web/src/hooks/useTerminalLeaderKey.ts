/**
 * useTerminalLeaderKey - 端末 (ttyd の iframe) の中で押された前置キーを Ark へ渡す
 *
 * iframe は別のブラウジングコンテキストなので、端末にフォーカスがある間のキーは
 * 親の window に届かない。ttyd は Ark と同じ出どころなので、iframe の document に
 * 捕捉段階のリスナーを付け、前置キーだけを横取りして親へ知らせる。ほかのキーには
 * 触らない (端末への入力を 1 バイトも変えない)。
 */

import { type RefObject, useEffect } from "react";
import { isLeaderKey } from "@/lib/keynav";

/** 端末の中で前置キーが押されたことを知らせる window イベント */
export const KEYNAV_LEADER_EVENT = "ark:keynav-leader";

export function useTerminalLeaderKey(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  /** iframe を貼り直すたびに変わる値 (貼り直したら付け直す) */
  iframeKey: unknown
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: iframeKey は「iframe が貼り直された」ことの合図として依存に置く
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let attached: Document | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isLeaderKey(event)) return;
      // xterm に渡さない (渡すと `;` が端末に入る)
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(KEYNAV_LEADER_EVENT));
    };
    const attach = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc || doc === attached) return;
        attached?.removeEventListener("keydown", onKeyDown, true);
        doc.addEventListener("keydown", onKeyDown, true);
        attached = doc;
      } catch {
        // 出どころが違う文書 (エラーページなど) には付けられない。前置キーが効かないだけ
      }
    };
    attach();
    // 読み込みが終わると document が入れ替わるので、そのたびに付け直す
    iframe.addEventListener("load", attach);
    return () => {
      iframe.removeEventListener("load", attach);
      attached?.removeEventListener("keydown", onKeyDown, true);
    };
  }, [iframeRef, iframeKey]);
}
