/**
 * 現行の会話 (JSONL transcript) に会話が 1 件でもあるかを見る。
 *
 * ## なぜ画面ではなく transcript を見るのか
 *
 * `/clear` を打つと端末はクリアされるのに、一覧の状態が「入力待ち」のまま
 * 残っていた。設計上は待機 (READY) に戻るはずで、既存の判定は
 * 「画面に意味あるテキストが無ければ READY」だった。
 *
 * **`/clear` 直後の画面は空にならない。** 実測 (Claude Code v2.1.276、
 * 2026-09-18、使い捨てセッションの capture-pane) では、こう残る:
 *
 * ```text
 *  ▐▛███▛█   Claude Code v2.1.276                       ← 起動バナー
 * ▝▜██████▀  Opus 5 (1M context) · Claude Max
 * ▎ Auto mode is now Claude Code's default permission…   ← 起動時のお知らせ
 * ▎ https://code.claude.com/docs/en/permission-modes
 * ❯ /clear                                               ← 打ったコマンド
 * ```
 *
 * バナーと `❯ /clear` は bridge-collector の isUiLine が UI として落とすが、
 * お知らせの行頭 `▎` (U+258E) は落とす文字の並び (▘▝▛▜▐▌█) に無いため
 * すり抜ける。この 1 種類の行だけで previewText は 327 文字になり、
 * 「空なら READY」には決して掛からなかった。
 *
 * CLI の状態ファイル (`<configDir>/sessions/<pid>.json`) でも区別できない。
 * 応答直後も /clear 直後も同じ `idle` を書く。
 *
 * 区別できるのは transcript だけである。`/clear` はその瞬間に新しい JSONL を
 * 作り、そこには会話が 1 件も無い (実測 7 レコード: mode /
 * file-history-snapshot / system / attachment / isMeta の user /
 * `<command-name>/clear</command-name>` の user)。会話がまだ無い transcript を
 * 映しているセッションは、まだ誰の番でもない。
 *
 * CLAUDE.md の「画面テキストから内容をパースしない」原則には反しない。読むのは
 * 画面ではなく JSONL で、取り出すのも会話の内容ではなく「レコードの種類」だけ。
 *
 * ## 上限と、読み切れなかったときの倒れ方
 *
 * 1 秒間隔の polling (getAllPreviews / bridge-collector) に載るため、全文は
 * 読まない。先頭 32KB だけ読み、最初に会話が出た時点で打ち切る。
 *
 * 上限まで読んでも会話が見つからなかった場合は「無い」ではなく **unknown**
 * (判定できない) に倒す。切り詰めた先に会話が続いているかもしれないため。
 * 実データ 230 本での「最初の会話までのバイト数」は p50 5.7KB / p90 21KB /
 * max 109KB で、32KB を超えるのは 220 本中 7 本。その 7 本はいずれも会話を持つ
 * ファイルなので unknown = 既存の画面判定のまま、という安全側に倒れる。
 * 会話を持たない 10 本はすべて 21.7KB 以下で、上限の内側に収まっていた。
 *
 * 失敗 (ファイル無し・壊れた JSON・権限) もすべて unknown にする。polling を
 * 落とさず、ログ洪水も作らない (pickLatestJsonl と同じ作法)。
 */

import fs from "node:fs";
import path from "node:path";
import { rememberFifoEntry } from "./bounded-fifo-map.js";
import {
  encodeProjectDir,
  pickLatestJsonl,
  projectsDirFor,
} from "./claude-projects.js";

/**
 * 現行 transcript の見立て。
 *
 * - `has-conversation`: 会話が 1 件以上ある (= 誰かの番が始まっている)
 * - `no-conversation`: 会話が 1 件も無い (/clear 直後・起動直後)
 * - `unknown`: 判定できない。呼び出し側は既存の画面判定をそのまま使う
 */
export type TranscriptConversationState =
  | "has-conversation"
  | "no-conversation"
  | "unknown";

/** 先頭から読む上限。polling に載るので全文は読まない */
const HEAD_LIMIT_BYTES = 32 * 1024;

/** メモに残すファイル数。/clear のたびにパスが変わるので上限で抑える */
const MEMO_LIMIT = 128;

/** fs を差し替えてテストするための入出力 */
export interface TranscriptConversationIo {
  /** ディレクトリ内の現行 .jsonl を選ぶ。無ければ null */
  pickLatestJsonl(dir: string, expectedCwd: string): string | null;
  /** ファイルの大きさと mtime (メモの鍵) */
  statFile(file: string): { size: number; mtimeMs: number };
  /** 先頭 maxBytes だけ読む。maxBytes に達したら truncated */
  readHead(file: string, maxBytes: number): TranscriptHead;
}

/** 先頭だけ読んだ結果 */
export interface TranscriptHead {
  text: string;
  /** 上限に達して切り詰めた (= この先にまだ行がある) */
  truncated: boolean;
}

const defaultIo: TranscriptConversationIo = {
  pickLatestJsonl,
  statFile: file => {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  },
  readHead: (file, maxBytes) => {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return {
        text: buffer.toString("utf-8", 0, read),
        truncated: read >= maxBytes,
      };
    } finally {
      fs.closeSync(fd);
    }
  },
};

interface MemoEntry {
  size: number;
  mtimeMs: number;
  state: TranscriptConversationState;
}

/**
 * ファイルパス → 直近の見立て。
 *
 * 1 秒ごとの polling で同じファイルを読み直さないためのメモ。大きさか mtime が
 * 動いたら読み直す。ただし **`has-conversation` は覆らない** (JSONL は追記しか
 * されない) ので、以後そのファイルは二度と読まない。
 *
 * 消えたセッションの記録が残り続けないよう、FIFO で件数を抑える。/clear のたびに
 * 新しいパスが増えるため、件数だけが増え続ける形にはしない。
 */
const memo = new Map<string, MemoEntry>();

/** テスト用: メモを破棄する */
export function clearTranscriptConversationMemo(): void {
  memo.clear();
}

/**
 * worktree + configDir の現行 JSONL に会話があるかを返す。
 *
 * 現行ファイルの選び方は JsonlTailManager / readTranscriptLastUpdatedAt と同じ
 * 経路 (projectsDirFor → encodeProjectDir → pickLatestJsonl) を通すので、
 * チャットビューが映している会話と同じファイルを見る。
 */
export function readTranscriptConversationState(
  worktreePath: string,
  configDir: string | null | undefined,
  io: TranscriptConversationIo = defaultIo
): TranscriptConversationState {
  // 復元時に pane_current_path を取れなかったセッションは worktreePath が空になる。
  // 空のまま進むと pickLatestJsonl が cwd 検証なしで projects 直下を見てしまう
  if (!worktreePath) return "unknown";
  try {
    const dir = path.join(
      projectsDirFor(configDir),
      encodeProjectDir(worktreePath)
    );
    const file = io.pickLatestJsonl(dir, worktreePath);
    if (!file) return "unknown";
    const cached = memo.get(file);
    if (cached?.state === "has-conversation") return "has-conversation";
    const { size, mtimeMs } = io.statFile(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs)
      return cached.state;
    const state = classifyHead(io.readHead(file, HEAD_LIMIT_BYTES));
    rememberFifoEntry(memo, file, { size, mtimeMs, state }, MEMO_LIMIT);
    return state;
  } catch {
    return "unknown";
  }
}

/** 先頭だけ読んだテキストを、最初の会話で打ち切って判定する */
function classifyHead(head: TranscriptHead): TranscriptConversationState {
  const lines = head.text.split("\n");
  // 上限で切れた場合、末尾は行の途中かもしれないので捨てる
  if (head.truncated) lines.pop();
  for (const line of lines) {
    if (line === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // 書き込み途中の行など。次の行へ (pickLatestJsonl の readFileCwd と同じ作法)
      continue;
    }
    if (isConversationRecord(record)) return "has-conversation";
  }
  // 会話が無いまま上限に達したなら、この先を見ていないので「無い」とは言えない
  return head.truncated ? "unknown" : "no-conversation";
}

/**
 * 1 レコードが「会話」かを見る。
 *
 * 会話とみなすのは:
 *   - `assistant` のレコード
 *   - 自動コンパクトの要約 (`isCompactSummary`)。会話の続きなので待機に落とさない
 *   - 素の `user` レコード
 *
 * 会話とみなさないのは、/clear 直後の JSONL に実際に入っていたものだけ:
 *   - `mode` / `file-history-snapshot` / `system` / `attachment` 等、user でも
 *     assistant でもないレコード
 *   - `isMeta` の user (`<local-command-caveat>…`)
 *   - slash command の user (`<command-name>/clear</command-name>`) と、その
 *     出力 (`<local-command-stdout>…`)
 */
function isConversationRecord(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const fields = record as Record<string, unknown>;
  // 実データの isCompactSummary は isMeta: null と同居するので、user 判定より先に見る
  if (fields.isCompactSummary === true) return true;
  if (fields.type === "assistant") return true;
  if (fields.type !== "user") return false;
  if (fields.isMeta === true) return false;
  const text = firstText(fields.message);
  if (text.startsWith("<command-name>")) return false;
  if (text.startsWith("<local-command-")) return false;
  return true;
}

/**
 * message.content の先頭テキストを取り出す。
 *
 * content は文字列のことも、ブロックの配列のこともある。tool_result だけの配列の
 * ように文字が無い場合は空文字を返し、**会話として数える**。そうしたレコードは
 * assistant のあとにしか現れないので、先に assistant で確定している。
 */
function firstText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trimStart();
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") return text.trimStart();
  }
  return "";
}
