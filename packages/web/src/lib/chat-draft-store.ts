/**
 * チャット入力欄への下書きの置き場。worktreeのパスを鍵にして1件だけ持つ。
 * 送信はしない (入れるだけ)。メモリにだけ持ち、リロードで消えてよい。
 * React外 (Dashboardのハンドラ) からも呼べるよう、モジュールの小さなstoreにしてある。
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

/** 下書きを置く。同じworktreeに既にあれば置き換える */
export function requestChatDraft(worktreePath: string, text: string): void {
  drafts.set(worktreePath, text);
  for (const listener of [...listeners]) listener();
}

/** 下書きを受け取って消す。無ければnull */
export function takeChatDraft(worktreePath: string): string | null {
  const text = drafts.get(worktreePath);
  if (text === undefined) return null;
  drafts.delete(worktreePath);
  return text;
}

/** 下書きが置かれたときの通知を購読する。戻り値は解除関数 */
export function subscribeChatDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
