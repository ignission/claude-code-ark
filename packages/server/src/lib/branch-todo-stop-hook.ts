/**
 * 分岐TODO: Claude が返答を終えるたびに (Stop hook)、Jev へ「このターンに保留した
 * 話題があるか」を問い、閾値を超えたら Claude 自身に todo_add で足させる。
 *
 * 流れ:
 *   claude の Stop hook (auq-hook-bridge が --settings で注入) が hook の入力を
 *   Ark へ POST する → Ark が transcript から直前のターン (人の発話と返答) を組み立てて
 *   Jev に判定させる → 足すべきなら `{ decision: "block", reason }` を返す → claude は
 *   止まらずに reason を受け取り、todo_list で既存を確かめてから todo_add する。
 *
 * - tmux には 1 バイトも送らない。send-keys で頼むと、端末で入力中の下書きを
 *   C-u で消しうる (bridgeStatus は入力中を IDLE と報告する) ため
 * - Claude への入力に足すのは「外部の分類器がこのターンに保留した話題があると判定した」
 *   という、Claude 自身が持っていない情報だけ (CLAUDE.md の「コンテキスト機構は持たない」)。
 *   TODO の一覧はセッションへ渡さない (Claude が todo_list で自分で読む)
 *
 * 止める条件 (block しない):
 *   - `stop_hook_active` (block で続けたターンの終わり。ここで止めないと無限に続く)
 *   - そのターンで Claude が既に todo_add している
 *   - 無効・鍵なし・本文なし・人の発話が読めない・Jev の失敗・閾値未満
 *
 * transcript は種別 (type / isMeta / isSidechain / content block の種別) だけを見る。
 * 画面テキストの解釈はしない (CLAUDE.md の情報源分離の原則)。
 */

import fs from "node:fs";
import type { DeferredDecision } from "./jev-client.js";

/**
 * 撤去したボード提案の時代の名前のまま。稼働中のセッションは起動時に注入された
 * hook の設定にこの URL を持ち続けるので、変えるとそれらのセッションで判定が止まる
 */
export const STOP_HOOK_PATH = "/api/internal/board-suggest-stop";

/** transcript は末尾だけ読む。直前のターンが収まれば足りる */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** 保留した話題があると判定されたときに Claude が受け取る指示 */
export const BRANCH_TODO_REASON = [
  "Ark の分岐TODO: このターンで保留・後回し・別件にした話題があると判定された。",
  "todo_list で既存の TODO を確かめ、まだ無いものだけ todo_add で足すこと (1 件 1 行。あとで人間が読んで思い出せる言葉で)。",
  "保留した話題が無いと判断したら何も足さない。チャットには足したことを 1 行で伝えるだけにする。",
  "todo_list / todo_add が使えない (ツール一覧に無い) ときは何もしない。",
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

/** 直前のターン (最後の人の発話より後) の本文と、そのターンで todo_add したか */
export interface LastTurn {
  text: string;
  /** 区切りになった人の発話。読めなければ空文字 */
  prompt: string;
  /** そのターンで todo_add を呼んだか */
  addedTodo: boolean;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

/** user 行の本文。文字列か text block の配列のどちらでも読む */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n")
    .trim();
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
  let prompt = "";
  let addedTodo = false;
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
        prompt = userText(content);
        addedTodo = false;
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
        /(^|__)todo_add$/.test(block.name)
      ) {
        addedTodo = true;
      }
    }
  }
  return { text: texts.join("\n\n").trim(), prompt, addedTodo };
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

export interface BranchTodoStopDeps {
  apiKey(): string | null;
  todoEnabled(): boolean;
  todoThreshold(): number;
  decideDeferred(
    prompt: string,
    reply: string,
    apiKey: string
  ): Promise<DeferredDecision>;
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
export class BranchTodoStopHandler {
  /** Jev の同じ失敗を毎ターン出さないため、失敗中のセッションを覚える */
  private failing = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: BranchTodoStopDeps) {
    this.log = deps.log ?? (message => console.log(`[BranchTodo] ${message}`));
  }

  async handle(
    sessionId: string,
    input: StopHookInput
  ): Promise<StopHookOutput | null> {
    if (input.stopHookActive) return null;
    if (!this.deps.todoEnabled()) return null;
    const apiKey = this.deps.apiKey();
    if (!apiKey) return null;

    const lastMessage = input.lastAssistantMessage?.trim() ?? "";
    let turn: LastTurn = { text: "", prompt: "", addedTodo: false };
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
    // 質問は人の発話と返答の対で問うので、発話が読めなければ判定しない
    if (!text || !turn.prompt || turn.addedTodo) return null;

    const deferred = await this.judge(sessionId, () =>
      this.deps.decideDeferred(turn.prompt, text, apiKey)
    );
    if (!deferred || deferred.deferred < this.deps.todoThreshold()) {
      return null;
    }
    this.log(
      `${sessionId}: TODO を依頼 (deferred=${deferred.deferred.toFixed(2)})`
    );
    return { decision: "block", reason: BRANCH_TODO_REASON };
  }

  /** Jev を呼び、失敗は null に畳む。同じ失敗を毎ターン出さないよう、セッションごとに覚える */
  private async judge<T>(
    sessionId: string,
    run: () => Promise<T>
  ): Promise<T | null> {
    const key = sessionId;
    try {
      const result = await run();
      if (this.failing.delete(key)) this.log(`${key}: Jev が回復した`);
      return result;
    } catch (err) {
      if (!this.failing.has(key)) {
        this.log(`${key}: 判定に失敗 (以後同じ失敗は出さない): ${String(err)}`);
        this.failing.add(key);
      }
      return null;
    }
  }
}
