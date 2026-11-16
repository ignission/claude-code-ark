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

/**
 * 入力欄を通さずに送る文の置き場 (ボードの「Claudeに渡す」の定型文など)。
 * 会話の画面が受け取って、入力欄から送ったときと同じ経路で送る (送信中の吹き出しも出す)。
 * 書きかけの下書きには触らない。
 */
const sends = new Map<string, string[]>();

export function requestChatSend(worktreePath: string, text: string): void {
  sends.set(worktreePath, [...(sends.get(worktreePath) ?? []), text]);
  for (const listener of [...listeners]) listener();
}

/** 送る文を受け取って消す。無ければ空 */
export function takeChatSends(worktreePath: string): string[] {
  const texts = sends.get(worktreePath) ?? [];
  sends.delete(worktreePath);
  return texts;
}

/** 下書きや送る文が置かれたときの通知を購読する。戻り値は解除関数 */
export function subscribeChatDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
