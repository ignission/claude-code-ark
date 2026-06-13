/**
 * JsonlTailManager - Claude Code が永続化する JSONL セッションログを
 * リアルタイム tail し、新規行をコールバックで通知する。
 *
 * 背景:
 *   Claude Code は対話履歴を `<configDir>/projects/<encoded-cwd>/<uuid>.jsonl`
 *   に永続化する。tmux 画面パースよりも遥かに情報量の多い構造化データ
 *   (tool_use の input 全文、tool_result 全長、AskUserQuestion の質問/回答など)
 *   が含まれるため、チャットビューのデータソースとして利用する。
 *   **会話内容の情報源はこの JSONL のみ** とし、tmux capture-pane から内容を
 *   パースすることはしない (チャット UI v3 の設計原則)。
 *
 * 仕組み:
 *   - worktreePath を encodeProjectDir して projects 配下のディレクトリを特定
 *   - そのディレクトリ内で mtime 最新の *.jsonl を「現行ファイル」として選ぶ
 *     (encode 衝突対策として先頭行の cwd フィールド検証つき)
 *   - fs.watch (file) + 1 秒 polling で増分読み。fs.watch だけだと Claude CLI
 *     のバッファリングで追記イベントを取りこぼすため polling を併用する
 *   - ディレクトリに新しい *.jsonl が出現したら mtime 比較で切り替える
 *     (/clear や resume で新セッションが始まったケース)。切替時は onReset を
 *     先に通知してから新ファイル先頭の行を流す
 *   - polling は tail 単位で常時起動する。subscribe 時点で encoded ディレクトリ
 *     や .jsonl が未作成でも、後から出現した時点で自動的に拾う
 *     (旧実装は未作成だと watcher が起動せず購読が死ぬバグがあった)
 *   - 1 tail = 1 (worktreePath, configDir)。複数 socket が同じ worktree を
 *     購読する場合は refcount で共有する
 */

import fs from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  pickLatestJsonl,
  projectsDirFor,
} from "./claude-projects.js";

export interface JsonlLine {
  /** 行の元 JSON 文字列 (失敗時はパース不可な生文字列が入る) */
  raw: string;
  /** パース成功時の JSON (失敗時 undefined) */
  parsed?: unknown;
  /** どの .jsonl ファイルから来たか (ファイル切替の検出用) */
  filePath: string;
}

/**
 * 購読者に渡す listener。`/clear` や resume で JSONL ファイルが切り替わると
 * onReset が先に呼ばれ、続いて新ファイル先頭からの行が onLine で流れる。
 * onReset を実装する側は「これまで蓄積した行を破棄する」責務を持つ。
 */
export interface JsonlListener {
  onLine: (line: JsonlLine) => void;
  onReset?: () => void;
}

interface ActiveTail {
  worktreePath: string;
  encodedDir: string;
  /** 現行 .jsonl ファイル絶対パス。null なら未発見 */
  currentFile: string | null;
  /** 現行ファイルで読み込み済みのバイト数 (増分読み出し位置) */
  readOffset: number;
  /** 現行ファイルの行ぶった切り防止用バッファ */
  lineBuffer: string;
  /** ディレクトリ watcher (新 .jsonl 出現の即時検知用。polling が保険) */
  dirWatcher: fs.FSWatcher | null;
  /** ファイル watcher (fs.watch ベース。Linux で追記イベント取りこぼしあり) */
  fileWatcher: fs.FSWatcher | null;
  /**
   * polling fallback。tail 単位で常時起動し、
   * - 現行ファイルの増分 drain (fs.watch の取りこぼし対策)
   * - encoded dir / .jsonl が後から出現したときの自己回復
   * - dirWatcher が起動できなかった場合のファイル切替検知
   * を兼ねる。
   */
  pollTimer: NodeJS.Timeout | null;
  /** このセッションを購読中の listener 集合 */
  listeners: Set<JsonlListener>;
}

export class JsonlTailManager {
  /** key = `${worktreePath} ${configDir ?? ""}` (同一 worktree でも configDir 違いは別 tail) */
  private tails = new Map<string, ActiveTail>();

  private keyOf(worktreePath: string, configDir: string | null | undefined) {
    // 空白区切りの単純連結だと空白を含む path/configDir で衝突し、
    // 別セッションの tail/listener が混線するため衝突しない表現にする
    return JSON.stringify([worktreePath, configDir ?? null]);
  }

  /**
   * worktree の JSONL を購読する。listener.onLine が新規行ごとに呼ばれる。
   * `/clear` 等で JSONL ファイルが切り替わると onReset が先に呼ばれ、
   * その後 onLine で新ファイル先頭からの行が流れる。
   * configDir はセッションごとに異なる CLAUDE_CONFIG_DIR を反映するため必須。
   * 戻り値はクリーンアップ関数 (購読解除)。
   */
  subscribe(
    worktreePath: string,
    configDir: string | null | undefined,
    listener: JsonlListener
  ): () => void {
    const key = this.keyOf(worktreePath, configDir);
    let tail = this.tails.get(key);
    if (!tail) {
      tail = this.startTail(worktreePath, configDir);
      this.tails.set(key, tail);
    }
    tail.listeners.add(listener);

    return () => {
      const t = this.tails.get(key);
      if (!t) return;
      t.listeners.delete(listener);
      if (t.listeners.size === 0) {
        this.stopTail(key);
      }
    };
  }

  /**
   * 購読開始と初期 snapshot の取得を原子的に行う。
   *
   * subscribe (tail の読み出し offset 確定) と snapshot 読みを別々に行うと、
   * その間に追記された行が snapshot にも onLine にも入らず欠落する。
   * ここでは同一同期処理内で tail の確定 offset を先に固定し、その offset
   * までの末尾 `limit` 行を snapshot として返す。offset 以降の追記は必ず
   * onLine で届くため、snapshot と増分が隙間なく連続する。
   */
  subscribeWithSnapshot(
    worktreePath: string,
    configDir: string | null | undefined,
    listener: JsonlListener,
    limit = 100
  ): { snapshot: JsonlLine[]; unsubscribe: () => void } {
    const unsubscribe = this.subscribe(worktreePath, configDir, listener);
    const tail = this.tails.get(this.keyOf(worktreePath, configDir));
    let snapshot: JsonlLine[] = [];
    if (tail?.currentFile) {
      // readOffset には lineBuffer (改行未到達の断片) のバイト数も含まれる。
      // 断片が snapshot 末尾に不完全 JSON 行として混入しないよう、
      // 確定行境界までを snapshot の上限にする
      const settled =
        tail.readOffset - Buffer.byteLength(tail.lineBuffer, "utf-8");
      snapshot = this.readTailLines(tail.currentFile, limit, settled);
    }
    return { snapshot, unsubscribe };
  }

  /**
   * 購読中のすべてのファイルを閉じる (サーバ終了時など)
   */
  cleanup(): void {
    for (const key of this.tails.keys()) {
      this.stopTail(key);
    }
  }

  /**
   * 初回購読時に過去履歴を一括取得したい場合に使う。
   * 現行ファイルの末尾 `limit` 行 (デフォルト 100) を listener なしで返す。
   * 長い履歴で初回ロードが重くなるのを避けるため全行ではなく末尾を返す。
   */
  readCurrentSnapshot(
    worktreePath: string,
    configDir: string | null | undefined,
    limit = 100
  ): JsonlLine[] {
    const encodedDir = path.join(
      projectsDirFor(configDir),
      encodeProjectDir(worktreePath)
    );
    const current = pickLatestJsonl(encodedDir, worktreePath);
    if (!current) return [];
    return this.readTailLines(current, limit);
  }

  // ===== internal =====

  private startTail(
    worktreePath: string,
    configDir: string | null | undefined
  ): ActiveTail {
    const encodedDir = path.join(
      projectsDirFor(configDir),
      encodeProjectDir(worktreePath)
    );
    const tail: ActiveTail = {
      worktreePath,
      encodedDir,
      currentFile: null,
      readOffset: 0,
      lineBuffer: "",
      dirWatcher: null,
      fileWatcher: null,
      pollTimer: null,
      listeners: new Set(),
    };

    // 最新 .jsonl を選んで、末尾までシークしておく
    // (購読開始後の「新規行」のみ流すため。過去履歴は readCurrentSnapshot 経由で取得)
    const latest = pickLatestJsonl(encodedDir, worktreePath);
    if (latest) {
      tail.currentFile = latest;
      try {
        tail.readOffset = fs.statSync(latest).size;
      } catch {
        tail.readOffset = 0;
      }
      this.startFileWatcher(tail);
    }

    this.tryStartDirWatcher(tail);

    // tail 単位の常時 polling (増分 drain + dir/file 後発出現の自己回復)
    tail.pollTimer = setInterval(() => {
      this.pollTick(tail);
    }, 1000);

    return tail;
  }

  private stopTail(key: string): void {
    const tail = this.tails.get(key);
    if (!tail) return;
    this.stopFileWatcher(tail);
    tail.dirWatcher?.close();
    tail.dirWatcher = null;
    if (tail.pollTimer) {
      clearInterval(tail.pollTimer);
      tail.pollTimer = null;
    }
    this.tails.delete(key);
  }

  /**
   * ディレクトリ watcher を起動する。encoded ディレクトリがまだ無い場合は
   * 失敗のまま (pollTick が後から再試行する)。
   */
  private tryStartDirWatcher(tail: ActiveTail): void {
    if (tail.dirWatcher) return;
    try {
      tail.dirWatcher = fs.watch(tail.encodedDir, () => {
        this.checkFileSwitch(tail);
      });
    } catch {
      tail.dirWatcher = null;
    }
  }

  /**
   * 1 秒ごとの polling 本体。
   * - dirWatcher が未起動なら再試行 (encoded dir が後から作られたケース)
   * - 現行ファイル未発見なら再評価し、見つかれば先頭から読む
   * - 現行ファイルがあればファイル切替チェック + 増分 drain
   */
  private pollTick(tail: ActiveTail): void {
    if (!tail.dirWatcher) this.tryStartDirWatcher(tail);
    if (!tail.currentFile) {
      const latest = pickLatestJsonl(tail.encodedDir, tail.worktreePath);
      if (latest) {
        // 購読開始時には存在しなかったファイル = 新規セッションなので先頭から読む
        tail.currentFile = latest;
        tail.readOffset = 0;
        tail.lineBuffer = "";
        this.startFileWatcher(tail);
        this.drainNewLines(tail);
      }
      return;
    }
    // dirWatcher が機能していないプラットフォームでも切替を検知できるよう
    // polling 側でも軽量チェックする (readdir + stat 程度)
    this.checkFileSwitch(tail);
    this.drainNewLines(tail);
  }

  /**
   * ディレクトリ内の最新 .jsonl が現行ファイルと異なれば切り替える
   * (/clear / resume で新セッションが始まったケース)。
   * listener には onReset を先に通知してから新ファイル先頭の行を流す。
   * 順序が逆だと新ファイルの先頭行が旧 events 末尾に append されてしまう。
   */
  private checkFileSwitch(tail: ActiveTail): void {
    const newest = pickLatestJsonl(tail.encodedDir, tail.worktreePath);
    if (!newest || newest === tail.currentFile) return;
    this.stopFileWatcher(tail);
    tail.currentFile = newest;
    tail.readOffset = 0;
    tail.lineBuffer = "";
    for (const listener of tail.listeners) {
      try {
        listener.onReset?.();
      } catch (err) {
        console.error("[JsonlTail] reset listener error:", err);
      }
    }
    this.startFileWatcher(tail);
    this.drainNewLines(tail);
  }

  private startFileWatcher(tail: ActiveTail): void {
    if (!tail.currentFile) return;
    try {
      tail.fileWatcher = fs.watch(tail.currentFile, () => {
        this.drainNewLines(tail);
      });
    } catch {
      tail.fileWatcher = null;
    }
  }

  private stopFileWatcher(tail: ActiveTail): void {
    tail.fileWatcher?.close();
    tail.fileWatcher = null;
  }

  private drainNewLines(tail: ActiveTail): void {
    if (!tail.currentFile) return;
    let size: number;
    try {
      size = fs.statSync(tail.currentFile).size;
    } catch {
      return;
    }
    if (size <= tail.readOffset) {
      // truncate/rotate された場合はリセットしてもう一度読む
      if (size < tail.readOffset) {
        tail.readOffset = 0;
        tail.lineBuffer = "";
      } else {
        return;
      }
    }
    const fd = fs.openSync(tail.currentFile, "r");
    try {
      // 巨大な一括追記 (resume での過去ログ流入等) でも一度に確保する
      // バッファを上限内に抑える。残りは直後の setImmediate で続きを処理する
      const MAX_DRAIN_BYTES = 4 * 1024 * 1024;
      const length = Math.min(size - tail.readOffset, MAX_DRAIN_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, tail.readOffset);
      tail.readOffset += length;
      const chunk = tail.lineBuffer + buf.toString("utf-8");
      const lines = chunk.split("\n");
      // 最後の要素は改行で終わっていない可能性 → バッファに残す
      tail.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        const event = this.parseLine(line, tail.currentFile);
        for (const l of tail.listeners) {
          try {
            l.onLine(event);
          } catch (err) {
            console.error("[JsonlTail] listener error:", err);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    // 上限で打ち切った読み残しを即時に続行する (1 tick あたりの処理量は
    // 上限内に保ちつつ、次の polling まで読み残しを放置しない)。
    // 各回で readOffset が必ず前進するため有限回で収束する
    if (size > tail.readOffset) {
      setImmediate(() => {
        // 続行前に購読が解除されていれば何もしない
        if (tail.listeners.size > 0) this.drainNewLines(tail);
      });
    }
  }

  private parseLine(raw: string, filePath: string): JsonlLine {
    try {
      return { raw, parsed: JSON.parse(raw), filePath };
    } catch {
      return { raw, filePath };
    }
  }

  /**
   * 現行ファイルの末尾 `limit` 行を返す (初回 snapshot 用)。
   * 巨大ファイルでも先に全行 split せず、末尾から逆方向にチャンク読みする。
   * `upToBytes` を渡すとそのバイト位置までを「末尾」として扱う
   * (subscribeWithSnapshot が tail offset と snapshot を一致させるために使う)。
   */
  private readTailLines(
    filePath: string,
    limit: number,
    upToBytes?: number
  ): JsonlLine[] {
    try {
      const stat = fs.statSync(filePath);
      const end = Math.max(0, Math.min(upToBytes ?? stat.size, stat.size));
      if (end === 0 || limit <= 0) return [];
      const fd = fs.openSync(filePath, "r");
      try {
        const CHUNK = 64 * 1024;
        let pos = end;
        let buffer = "";
        let newlineCount = 0;
        // 末尾から CHUNK ごとに読みつつ、改行が `limit` 件以上含まれるまで遡る
        while (pos > 0 && newlineCount <= limit) {
          const readSize = Math.min(CHUNK, pos);
          pos -= readSize;
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, pos);
          const chunk = buf.toString("utf-8");
          buffer = chunk + buffer;
          newlineCount = 0;
          for (let i = 0; i < buffer.length; i++) {
            if (buffer.charCodeAt(i) === 10) newlineCount++;
          }
        }
        const all = buffer.split("\n");
        // 先頭行が読み込み境界で切れている可能性 → ファイル先頭まで遡っていなければ捨てる
        if (pos > 0 && all.length > 0) all.shift();
        // 末尾の空要素 (ファイル末尾の \n 由来) は実体行ではないので落としてから
        // スライスする。これをやらないと limit-1 件しか返らない off-by-one になる。
        while (all.length > 0 && all[all.length - 1] === "") all.pop();
        const sliced = all.slice(Math.max(0, all.length - limit));
        const out: JsonlLine[] = [];
        for (const line of sliced) {
          if (line === "") continue;
          out.push(this.parseLine(line, filePath));
        }
        return out;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }
}

export const jsonlTailManager = new JsonlTailManager();
