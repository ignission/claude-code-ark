/**
 * tmux 読み取り系の結果型 (#393)
 *
 * 以前は `TmuxManager` の読み取り系メソッド (getEnv / getPaneEnv / getBuffer /
 * capturePane / capturePaneVisible) が **tmux コマンドの失敗** と **値が無いこと**
 * を同じ `null` に畳んでいた。そのためセッションが消えた・復元できない・env が
 * 読めないとき、「tmux サーバーが死んでいた」のか「変数が未設定だった」のかが
 * 事後に一切追えず、復元の分岐を誤ったまま黙って進んでいた。
 *
 * `managed-worktree.ts` と同じ方式で失敗要因を型で区別して返し、呼び出し側が
 * ログ・メッセージに tmux の exit status / stderr / errno まで載せられるようにする。
 */

export type TmuxReadFailure =
  /** TmuxManager がそのセッション ID を管理していない (未登録 / kill 済み) */
  | { kind: "no-session" }
  /**
   * tmux コマンド自体が失敗した。非 0 終了 (セッション不在・サーバー停止等) と、
   * プロセス起動失敗 (ENOENT) / timeout (ETIMEDOUT + signal) の両方を含む。
   * どちらかは `status` / `code` / `signal` で判別できる
   */
  | {
      kind: "tmux-failed";
      /** tmux サブコマンド名 (例: "capture-pane") */
      command: string;
      status: number | null;
      signal: NodeJS.Signals | null;
      /** stderr (trim 済み)。tmux の "no such session: x" 等がそのまま入る */
      stderr: string;
      /** spawnSync が error を返した場合の errno code (ENOENT / ETIMEDOUT 等) */
      code?: string;
      /** spawnSync が error を返した場合の message */
      message?: string;
    }
  /** tmux は成功したが、要求した環境変数が設定されていない */
  | { kind: "not-set" }
  /** tmux は成功したが、ペーストバッファが 1 つも無い */
  | { kind: "no-buffer" }
  /** `list-panes -F #{pane_pid}` の出力が pid として解釈できない */
  | { kind: "invalid-pane-pid"; raw: string }
  /** `/proc/<pid>/environ` の読み取りに失敗した (ENOENT / EACCES 等) */
  | { kind: "proc-error"; code: string; message: string }
  /** pane environ の読み取りは /proc のある Linux 限定 */
  | { kind: "unsupported-platform"; platform: string };

export type TmuxReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: TmuxReadFailure };

/** 失敗要因を人間が読める 1 行に落とす (ログ・エラーメッセージ用) */
export function describeTmuxReadFailure(failure: TmuxReadFailure): string {
  switch (failure.kind) {
    case "no-session":
      return "TmuxManager が管理していないセッション ID です";
    case "tmux-failed": {
      const parts = [`status=${failure.status ?? "null"}`];
      if (failure.signal) parts.push(`signal=${failure.signal}`);
      if (failure.code) parts.push(`code=${failure.code}`);
      const detail = failure.stderr || failure.message || "";
      return `tmux ${failure.command} が失敗しました (${parts.join(", ")})${
        detail ? `: ${detail}` : ""
      }`;
    }
    case "not-set":
      return "変数が未設定です";
    case "no-buffer":
      return "tmux ペーストバッファがありません";
    case "invalid-pane-pid":
      return `pane_pid を解釈できません: ${JSON.stringify(failure.raw)}`;
    case "proc-error":
      return `/proc の読み取りに失敗しました (${failure.code}): ${failure.message}`;
    case "unsupported-platform":
      return `pane environ の読み取りは Linux 限定です (platform=${failure.platform})`;
  }
}

/**
 * polling 経路 (1 秒間隔の preview / bridge 収集) で同じ失敗を毎 tick 出力しない
 * ための状態付きロガー。
 *
 * key (通常は sessionId) ごとに直前の失敗の説明文を覚え、内容が変わったときだけ
 * 出力する。成功に戻ったら回復を 1 行出して記録を消す (時系列の再構成に使う)。
 */
export class TmuxReadFailureReporter {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly prefix: string,
    private readonly log: (message: string) => void = (message: string) =>
      console.warn(message)
  ) {}

  /** 結果を観測する。失敗なら必要に応じて出力し、成功なら回復を出力する */
  report(key: string, result: TmuxReadResult<unknown>): void {
    if (result.ok) {
      if (this.last.delete(key)) {
        this.log(`${this.prefix} ${key}: tmux の読み取りが回復しました`);
      }
      return;
    }
    const text = describeTmuxReadFailure(result.failure);
    if (this.last.get(key) === text) return;
    this.last.set(key, text);
    this.log(`${this.prefix} ${key}: ${text}`);
  }

  /** セッション削除時などに記録を消す */
  forget(key: string): void {
    this.last.delete(key);
  }
}
