/**
 * ボード提案: Claude の返答が終わるたびに Jev へ「ボードに出したほうが読みやすいか」を
 * 問い、閾値を超えたら Ark が動く。
 *
 * - form=doc: 返答の markdown を doc 型ボードへ機械変換して開く (Claude のトークン 0)
 * - form=figure: Claude に 1 行の作図依頼を送る (Jev がそう判定した稀な場合だけ)
 *
 * 判定も実行も人間に尋ねない。人間が見るのは「ボードが開いた」ことと、
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

/** form=figure のとき Claude に送る 1 行。board_open まで含めて依頼する */
export const FIGURE_REQUEST_MESSAGE =
  "直前の説明を図解して board_open で開いて (board_authoring_guide の規約に従う)";

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
  /** 書いた doc をセッションのボードで開く (readDiagram の検証込み) */
  openDiagram(
    sessionId: string,
    relPath: string
  ): Promise<{ ok: boolean; error?: string }>;
  /** Claude が手を止めているか (作図依頼を送ってよいか) */
  isIdle(sessionId: string): boolean;
  sendToClaude(sessionId: string, message: string): void;
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
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
    try {
      const decision = await this.deps.decide(text);
      if (state.failureReported) {
        this.log(`${session.id}: Jev が回復した`);
        state.failureReported = false;
      }
      if (decision.board < this.deps.threshold()) return;
      if (decision.form === "figure") {
        await this.requestFigure(session, decision);
      } else {
        await this.openAsDoc(session, decision, text);
      }
    } catch (err) {
      // 同じ失敗を毎ターン出さない
      if (!state.failureReported) {
        this.log(
          `${session.id}: 判定に失敗 (以後同じ失敗は出さない): ${String(err)}`
        );
        state.failureReported = true;
      }
    } finally {
      state.inflight = false;
    }
  }

  private async openAsDoc(
    session: BoardSuggestSession,
    decision: BoardDecision,
    text: string
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
    const relPath = path.posix.join(
      DIAGRAM_DIR,
      BOARD_SUGGEST_AUTO_DIR,
      session.id,
      `${formatStamp(at)}.diagram.html`
    );
    const absPath = path.join(worktreeReal, relPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    // 既存ファイルは決して上書きしない (コメント sidecar が relPath に紐づくため)
    await fs.promises.writeFile(absPath, doc.html, {
      encoding: "utf-8",
      flag: "wx",
    });
    const opened = await this.deps.openDiagram(session.id, relPath);
    if (!opened.ok) {
      this.log(
        `${session.id}: 書いた doc を開けない: ${opened.error ?? "unknown"}`
      );
      return;
    }
    this.deps.notify({
      sessionId: session.id,
      at,
      probability: decision.board,
      form: "doc",
      relPath,
      title: doc.title,
    });
  }

  private async requestFigure(
    session: BoardSuggestSession,
    decision: BoardDecision
  ): Promise<void> {
    // tmux へ C-u + 文字列 + Enter を送るので、Claude が動いている最中や
    // 確認待ちのときは送らない (入力中の行を消しかねない)
    if (!this.deps.isIdle(session.id)) {
      this.log(`${session.id}: Claude が手を止めていないので作図依頼を見送る`);
      return;
    }
    this.deps.sendToClaude(session.id, FIGURE_REQUEST_MESSAGE);
    this.deps.notify({
      sessionId: session.id,
      at: this.now(),
      probability: decision.board,
      form: "figure",
      relPath: null,
      title: null,
    });
  }
}
