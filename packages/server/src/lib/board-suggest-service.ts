/**
 * ボード提案: Claude の返答が終わるたびに Jev へ「ボードに出したほうが読みやすいか」を
 * 問い、閾値を超えたら Ark が動く。
 *
 * - form=doc: 返答の markdown を doc 型ボードへ機械変換して開く (Claude のトークン 0)
 * - form=figure: 通知だけ出す。クライアントが「図にする」ボタンを出し、人間が押した
 *   ときだけ Claude へ作図依頼が送られる。サーバーが tmux へ自動送信すると、端末で
 *   入力中の下書きを C-u で消しうる (bridgeStatus は入力中を IDLE と報告する)
 *
 * doc は人間に尋ねず動く。人間が見るのは「ボードが開いた」ことと、
 * チャットに出る 1 行の通知 (`session:board-suggest`) だけ。
 *
 * これは Claude セッションへ context を注入する機構ではない (doc 経路は Claude に
 * 何も送らない)。`.claude/rules/context-engineering.md` の対象外。
 */

import fs from "node:fs";
import path from "node:path";
import { type BoardSuggestEvent, DIAGRAM_DIR } from "@ark/shared";
import { TurnAssembler } from "./board-suggest-turns.js";
import type { BoardDecision } from "./jev-client.js";
import { markdownToBoardDoc } from "./markdown-to-board-doc.js";

/** 自動生成した doc の置き場。`_` 始まりなので図スイッチャーの一覧には出ない */
export const BOARD_SUGGEST_AUTO_DIR = "_auto";

/** Jev の noul がこの値以上なら動く。0.5 付近は「分からない」なので高めに置く */
export const BOARD_SUGGEST_DEFAULT_THRESHOLD = 0.7;

export interface BoardSuggestSession {
  id: string;
  worktreePath: string;
  profileConfigDir?: string | null;
}

export interface JsonlLineLike {
  raw: string;
}

export interface BoardSuggestDeps {
  /** JsonlTailManager.subscribe と同じ契約 (購読開始後の新規行だけ流れる) */
  subscribeJsonl(
    worktreePath: string,
    configDir: string | null,
    listener: { onLine(line: JsonlLineLike): void; onReset?(): void }
  ): () => void;
  decide(text: string): Promise<BoardDecision>;
  /** 閾値。設定から毎回読む (再起動なしで変えられるように) */
  threshold(): number;
  /** worktree の realpath。解決できなければ null */
  resolveWorktreeReal(worktreePath: string): string | null;
  /**
   * 書いた doc をセッションのボードで開く (readDiagram の検証込み)。
   * `shouldAbort` は読み込み後・emit 直前に評価し、true なら開かない
   * (読んでいる間に会話が進んだ古い判定で、いま見ているボードを差し替えないため)
   */
  openDiagram(
    sessionId: string,
    relPath: string,
    shouldAbort: () => boolean
  ): Promise<{ ok: boolean; error?: string }>;
  notify(event: BoardSuggestEvent): void;
  now?(): number;
  log?(message: string): void;
}

interface SessionState {
  unsubscribe: () => void;
  assembler: TurnAssembler;
  inflight: boolean;
  failureReported: boolean;
}

function formatStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 同じ秒に 2 ターン確定しても衝突しないようミリ秒まで入れる
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export class BoardSuggestService {
  private sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: BoardSuggestDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log =
      deps.log ?? (message => console.log(`[BoardSuggest] ${message}`));
  }

  /** セッションの transcript を見張り始める。二重 attach は無視する */
  attach(session: BoardSuggestSession): void {
    if (this.sessions.has(session.id)) return;
    const assembler = new TurnAssembler();
    const state: SessionState = {
      unsubscribe: () => {},
      assembler,
      inflight: false,
      failureReported: false,
    };
    state.unsubscribe = this.deps.subscribeJsonl(
      session.worktreePath,
      session.profileConfigDir ?? null,
      {
        onLine: line => {
          // tail の drain を止めないよう、ここから外へは何も投げない
          try {
            const turn = assembler.push(line.raw);
            if (turn) void this.handleTurn(session, state, turn.text);
          } catch (err) {
            this.log(`${session.id}: 行の処理に失敗: ${String(err)}`);
          }
        },
        onReset: () => assembler.reset(),
      }
    );
    this.sessions.set(session.id, state);
  }

  detach(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.unsubscribe();
    this.sessions.delete(sessionId);
  }

  detachAll(): void {
    for (const id of [...this.sessions.keys()]) this.detach(id);
  }

  private async handleTurn(
    session: BoardSuggestSession,
    state: SessionState,
    text: string
  ): Promise<void> {
    // 判定中に次のターンが終わったら、そのターンは見送る (Jev は 1 秒以内に返るので稀)
    if (state.inflight) return;
    state.inflight = true;
    const generation = state.assembler.generation;
    // 判定の途中で会話が進んだ (新しい発話・/clear) か、detach されたら結果を捨てる。
    // 古い判定で「直前の説明」を扱うと、別の会話に対して動いてしまう
    const stale = () =>
      this.sessions.get(session.id) !== state ||
      state.assembler.generation !== generation;
    let decision: BoardDecision;
    try {
      decision = await this.deps.decide(text);
    } catch (err) {
      // Jev の同じ失敗を毎ターン出さない (ファイル操作の失敗はここに混ぜない)
      if (!state.failureReported) {
        this.log(
          `${session.id}: 判定に失敗 (以後同じ失敗は出さない): ${String(err)}`
        );
        state.failureReported = true;
      }
      state.inflight = false;
      return;
    }
    try {
      if (state.failureReported) {
        this.log(`${session.id}: Jev が回復した`);
        state.failureReported = false;
      }
      if (stale()) return;
      if (decision.board < this.deps.threshold()) return;
      if (decision.form === "figure") {
        this.deps.notify({
          sessionId: session.id,
          at: this.now(),
          probability: decision.board,
          form: "figure",
          relPath: null,
          title: null,
        });
      } else {
        await this.openAsDoc(session, decision, text, stale);
      }
    } catch (err) {
      // doc の書き出し・open の失敗は毎回そのまま残す (判定の失敗とは別の事象)
      this.log(`${session.id}: doc の書き出しに失敗: ${String(err)}`);
    } finally {
      state.inflight = false;
    }
  }

  private async openAsDoc(
    session: BoardSuggestSession,
    decision: BoardDecision,
    text: string,
    stale: () => boolean
  ): Promise<void> {
    const worktreeReal = this.deps.resolveWorktreeReal(session.worktreePath);
    if (!worktreeReal) {
      this.log(`${session.id}: worktree を解決できないので doc を書かない`);
      return;
    }
    const at = this.now();
    const doc = markdownToBoardDoc(
      text,
      `Claude の返答から自動生成 · ${new Date(at).toLocaleString("ja-JP")}`
    );
    const relDir = path.posix.join(
      DIAGRAM_DIR,
      BOARD_SUGGEST_AUTO_DIR,
      session.id
    );
    const relPath = path.posix.join(relDir, `${formatStamp(at)}.diagram.html`);
    const dirReal = await ensureContainedDir(worktreeReal, relDir);
    if (!dirReal) {
      this.log(
        `${session.id}: ${relDir} が worktree の外を指す (symlink) ので doc を書かない`
      );
      return;
    }
    if (stale()) return;
    const absPath = path.join(dirReal, path.posix.basename(relPath));
    const written = await writeFileConfined(absPath, doc.html);
    if (!written) {
      this.log(
        `${session.id}: ${relPath} の実体が worktree の外に作られたので書かない`
      );
      return;
    }
    // 書いている間に会話が進んでいたら、開かず知らせない (ファイルは残るが害はない)。
    // open の中でも読み込み後に同じ判定を評価させる
    if (stale()) return;
    const opened = await this.deps.openDiagram(session.id, relPath, stale);
    if (!opened.ok) {
      if (stale()) return;
      this.log(
        `${session.id}: 書いた doc を開けない: ${opened.error ?? "unknown"}`
      );
      return;
    }
    if (stale()) return;
    this.deps.notify({
      sessionId: session.id,
      at,
      probability: decision.board,
      form: "doc",
      relPath,
      title: doc.title,
    });
  }
}

/**
 * worktree 配下の相対ディレクトリを作り、その realpath が worktree の中に
 * 収まっていることを確かめて返す。途中の既存要素が symlink なら作る前に拒否する
 * (`.claude/diagrams/_auto` が外を指していると、mkdir も書き込みも外へ漏れる)。
 */
export async function ensureContainedDir(
  worktreeReal: string,
  relDir: string
): Promise<string | null> {
  const segments = relDir.split("/").filter(Boolean);
  let current = worktreeReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      break;
    }
  }
  const expected = path.join(worktreeReal, ...segments);
  await fs.promises.mkdir(expected, { recursive: true });
  const real = await fs.promises.realpath(expected);
  return real === expected ? real : null;
}

/**
 * 新規ファイルを作って書く。既存は上書きしない (O_EXCL)。
 *
 * 親ディレクトリは `ensureContainedDir` で確かめてあるが、その後に `_auto/<sid>` が
 * worktree の外を指す symlink へ差し替えられると、O_NOFOLLOW は最後の要素しか守らない
 * ので外に作られうる。そこで作った直後 (中身を書く前) に、握っている fd の inode が
 * 期待どおりの worktree 内パスに在ることを path 側の realpath + stat で照合する。
 * 一致しなければ空のまま消して false を返す。inode を握っているので、その後に
 * symlink を差し替えられても書き先は動かない。
 */
export async function writeFileConfined(
  absPath: string,
  content: string
): Promise<boolean> {
  const fd = await fs.promises.open(
    absPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o644
  );
  try {
    const created = await fd.stat();
    const real = await fs.promises.realpath(absPath).catch(() => null);
    const atPath =
      real === absPath ? await fs.promises.stat(real).catch(() => null) : null;
    const confined =
      atPath !== null &&
      atPath.ino === created.ino &&
      atPath.dev === created.dev;
    if (!confined) {
      await fd.close();
      await fs.promises.unlink(absPath).catch(() => {});
      return false;
    }
    await fd.writeFile(content, "utf-8");
    await fd.close();
    return true;
  } catch (err) {
    await fd.close().catch(() => {});
    throw err;
  }
}
