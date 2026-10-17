/**
 * useOpenTerminalOnAuq - AskUserQuestionの回答待ちが始まったら、端末の窓を開く
 *
 * 質問には端末で答える (選択肢のカードは持たない)。会話ビュー (SplitChatPane) の
 * `onActiveAuqChange` に返り値を渡すと、新しい質問が来たときに `openTerminal` を呼ぶ。
 *
 * - 開くのは質問ごとに1回 (`toolUseId` で見分ける)。サーバーは再購読・再接続のたびに
 *   回答待ちの質問を送り直すので、利用者が閉じた窓を同じ質問で開き直さない
 * - 表示中でない画面では開かない。そのときは開いた印も付けず、表示し直して
 *   (再購読で) 同じ質問が届いたときに開く
 * - 回答が済んでも窓は閉じない (端末での続きの操作を遮らない)
 */

import { useCallback, useRef } from "react";
import type { ActiveAuq } from "@/lib/ask-user-question-state";

export function useOpenTerminalOnAuq(
  isActive: boolean,
  openTerminal: () => void
): (auq: ActiveAuq | null) => void {
  const openedRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  return useCallback(
    (auq: ActiveAuq | null) => {
      if (!auq || !isActiveRef.current) return;
      if (openedRef.current === auq.toolUseId) return;
      openedRef.current = auq.toolUseId;
      openTerminal();
    },
    [openTerminal]
  );
}
