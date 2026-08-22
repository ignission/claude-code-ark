/**
 * 図解コメント mutation の「適用済み操作 ID」を覚えるプロセス内 LRU。
 *
 * クライアント側の ACK タイムアウトはサーバー処理を取り消さないため、
 * 再試行で同じ操作 ID が届いたときに再適用しないための記録として使う。
 *
 * sidecar に持たせない理由:
 * - sidecar は Claude / 人間が読む成果物で、再試行の都合を混ぜたくない
 * - 再試行はタイムアウト直後の秒〜分単位で起こる。サーバー再起動をまたぐ
 *   再試行は socket も切れるため稀で、プロセス内の記録で実用上足りる
 *
 * 値（レスポンス）は保持しない。sidecar は最大 1MiB あり、応答を保持すると
 * エントリ数 × 1MiB のメモリを抱えるため、再適用時は sidecar を読み直して返す。
 */
export const DIAGRAM_COMMENT_OPERATION_LOG_MAX_ENTRIES = 1000;

export class DiagramCommentOperationLog {
  private readonly entries = new Set<string>();

  constructor(
    private readonly maxEntries = DIAGRAM_COMMENT_OPERATION_LOG_MAX_ENTRIES
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries は 1 以上の整数が必要です");
    }
  }

  /** 記録済みなら true。参照されたエントリは最近使用として延命する。 */
  has(key: string): boolean {
    if (!this.entries.has(key)) return false;
    this.entries.delete(key);
    this.entries.add(key);
    return true;
  }

  /** 適用済みとして記録する。上限を超えたら最も古いエントリを捨てる。 */
  record(key: string): void {
    this.entries.delete(key);
    this.entries.add(key);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.values().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * 操作 ID の衝突範囲を (操作種別, 対象) に限定する key を作る。
 * クライアントが別ファイル・別種別で同じ ID を使い回しても混線しない。
 * 単純な文字列連結だと区切り文字を含む入力で衝突しうるため JSON で符号化する。
 */
export function diagramCommentOperationKey(
  kind: "create" | "reply" | "resolve" | "delete" | "send",
  scope: string,
  operationId: string
): string {
  return JSON.stringify([kind, scope, operationId]);
}

/** プロセス内で共有する適用済み操作の記録。 */
export const diagramCommentOperationLog = new DiagramCommentOperationLog();
