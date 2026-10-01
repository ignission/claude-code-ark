/**
 * ボード提案: Claude が返答を終えるたびに (Stop hook)、Jev へ「チャットより
 * ボードのほうが読みやすいか」を問い、閾値を超えたら Claude 自身に図解させる。
 *
 * 流れ:
 *   claude の Stop hook (auq-hook-bridge が --settings で注入) が hook の入力を
 *   Ark へ POST する → Ark が transcript から直前のターンの本文を組み立てて Jev に
 *   判定させる → 図解すべきなら `{ decision: "block", reason }` を返す → claude は
 *   止まらずに reason を受け取り、デッキを描いて board_open で開く。
 *
 * - tmux には 1 バイトも送らない。send-keys で頼むと、端末で入力中の下書きを
 *   C-u で消しうる (bridgeStatus は入力中を IDLE と報告する) ため
 * - Ark 自身は図を描けない。返答の文章をボードへ機械変換しても、チャットと同じ
 *   文章が別のペインに出るだけで読み手には何も足さない。描けるのは Claude だけ
 * - Claude への入力に足すのは「外部の分類器がこの返答を図にすべきと判定した」
 *   という、Claude 自身が持っていない情報だけ。SessionStart hook の作図規約を
 *   読み上げ直すものではない (`.claude/rules/context-engineering.md` の §4)
 *
 * 止める条件 (block しない):
 *   - `stop_hook_active` (block で続けたターンの終わり。ここで止めないと無限に続く)
 *   - そのターンで Claude が既に board_open している
 *   - 無効・鍵なし・本文なし・Jev の失敗・閾値未満
 *
 * transcript は種別 (type / isMeta / isSidechain / content block の種別) だけを見る。
 * 画面テキストの解釈はしない (CLAUDE.md の情報源分離の原則)。
 */

import fs from "node:fs";
import type { BoardDecision } from "./jev-client.js";

export const BOARD_SUGGEST_STOP_PATH = "/api/internal/board-suggest-stop";

/** transcript は末尾だけ読む。直前のターンが収まれば足りる */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * block したときに Claude が受け取る指示。会話ビューには折りたたんだ
 * システムの行 (isMeta) として出る
 */
export const BOARD_SUGGEST_REASON = [
  "Ark のボード提案: この返答はチャットの文章よりボードの図のほうが読みやすいと判定された。",
  "board_authoring_guide の「説明図（デッキ）」に従い、直前の返答の内容を 1 ページに 1 つのことを置くデッキにして、board_open で開くこと。",
  "新しい調査やコードの変更はしない。チャットには同じ説明を繰り返さず、開いたことを 1 行で伝えるだけにする。",
].join("\n");

/** Stop hook の入力のうち使うもの */
export interface StopHookInput {
  cwd: string;
  transcriptPath: string | null;
  stopHookActive: boolean;
  lastAssistantMessage: string | null;
}

/** hook の生 body を検証して取り出す。形が違えば null */
export function parseStopHookInput(body: unknown): StopHookInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== "Stop" || typeof b.cwd !== "string") return null;
  return {
    cwd: b.cwd,
    transcriptPath:
      typeof b.transcript_path === "string" &&
      b.transcript_path.endsWith(".jsonl")
        ? b.transcript_path
        : null,
    stopHookActive: b.stop_hook_active === true,
    lastAssistantMessage:
      typeof b.last_assistant_message === "string"
        ? b.last_assistant_message
        : null,
  };
}

/** 直前のターン (最後の人の発話より後) の本文と、そのターンで board_open したか */
export interface LastTurn {
  text: string;
  openedBoard: boolean;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

interface TranscriptRecord {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/**
 * transcript の行から直前のターンを組み立てる。
 *
 * ターンの区切りは人の発話 (tool_result でも isMeta でもない user 行)。
 * そこから後の assistant の text block をすべて連結する (返答は content block ごとに
 * 別の行で書かれ、ツール呼び出しを挟んで複数に分かれる)。
 */
export function extractLastTurn(lines: Iterable<string>): LastTurn {
  let texts: string[] = [];
  let openedBoard = false;
  for (const raw of lines) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(raw) as TranscriptRecord;
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    // subagent の transcript は本人の返答ではない
    if (record.isSidechain === true) continue;
    const content = record.message?.content;
    if (record.type === "user") {
      if (record.isMeta === true) continue;
      const isToolResult =
        Array.isArray(content) &&
        content.some(block => (block as ContentBlock)?.type === "tool_result");
      if (!isToolResult) {
        texts = [];
        openedBoard = false;
      }
      continue;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content as ContentBlock[]) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        texts.push(block.text);
      } else if (
        block?.type === "tool_use" &&
        typeof block.name === "string" &&
        /(^|__)board_open$/.test(block.name)
      ) {
        openedBoard = true;
      }
    }
  }
  return { text: texts.join("\n\n").trim(), openedBoard };
}

/** transcript の末尾を読み、行に分ける。途中から読んだ最初の欠けた行は捨てる */
export async function readTranscriptTail(
  transcriptPath: string,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES
): Promise<string[]> {
  const handle = await fs.promises.open(transcriptPath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf-8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(line => line.trim());
  } finally {
    await handle.close();
  }
}

export interface BoardSuggestStopDeps {
  enabled(): boolean;
  apiKey(): string | null;
  threshold(): number;
  decide(text: string, apiKey: string): Promise<BoardDecision>;
  readTranscript(transcriptPath: string): Promise<string[]>;
  log?(message: string): void;
}

export interface StopHookOutput {
  decision: "block";
  reason: string;
}

/**
 * Stop hook 1 回分の判定。block するなら hook の出力 JSON を、しないなら null を返す。
 * 失敗は投げない (hook が claude の進行を止めないことを最優先にする)。
 */
export class BoardSuggestStopHandler {
  /** Jev の同じ失敗を毎ターン出さないため、失敗中のセッションを覚える */
  private failing = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: BoardSuggestStopDeps) {
    this.log =
      deps.log ?? (message => console.log(`[BoardSuggest] ${message}`));
  }

  async handle(
    sessionId: string,
    input: StopHookInput
  ): Promise<StopHookOutput | null> {
    if (input.stopHookActive) return null;
    if (!this.deps.enabled()) return null;
    const apiKey = this.deps.apiKey();
    if (!apiKey) return null;

    const lastMessage = input.lastAssistantMessage?.trim() ?? "";
    let turn: LastTurn = { text: "", openedBoard: false };
    if (input.transcriptPath) {
      try {
        turn = extractLastTurn(
          await this.deps.readTranscript(input.transcriptPath)
        );
      } catch (err) {
        // transcript が読めなければ最後のメッセージだけで判定する
        this.log(`${sessionId}: transcript を読めない: ${String(err)}`);
      }
    }
    // hook の時点では最後の返答がまだ transcript に書かれていないことがある
    // (実機で確認)。hook の入力にある最後のメッセージを本文の末尾に補う
    const text =
      lastMessage && !turn.text.endsWith(lastMessage)
        ? [turn.text, lastMessage].filter(Boolean).join("\n\n")
        : turn.text;
    if (turn.openedBoard || !text) return null;

    let decision: BoardDecision;
    try {
      decision = await this.deps.decide(text, apiKey);
    } catch (err) {
      if (!this.failing.has(sessionId)) {
        this.log(
          `${sessionId}: 判定に失敗 (以後同じ失敗は出さない): ${String(err)}`
        );
        this.failing.add(sessionId);
      }
      return null;
    }
    if (this.failing.delete(sessionId)) {
      this.log(`${sessionId}: Jev が回復した`);
    }
    if (decision.board < this.deps.threshold()) return null;
    this.log(
      `${sessionId}: 図解を依頼 (board=${decision.board.toFixed(2)}, ${text.length} 文字)`
    );
    return { decision: "block", reason: BOARD_SUGGEST_REASON };
  }
}
