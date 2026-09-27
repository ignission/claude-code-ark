/**
 * JSONL transcript の行から「Claude の 1 ターン分の返答本文」を組み立てる。
 *
 * 対話版 claude は assistant の text block を 1 行ずつ書き、ツール呼び出しを
 * 挟みながら最後に `stop_reason: "end_turn"` の行でターンを終える。
 * ここでは直前のユーザー発話 (tool_result ではない user 行) 以降の text block を
 * すべて溜め、返答が終わったら連結して 1 つの本文として返す。
 * この区切り方は Jev の検証スクリプトと同じにしてある (数値をそのまま持ち込むため)。
 *
 * 1 つの返答は content block ごとに別の行で書かれ、どの行にも返答全体の
 * stop_reason が付く (thinking の行と本文の行が、どちらも end_turn を持つ)。
 * 本文が複数の行に分かれることもあり、行を見ただけでは返答の最後の行か分からない。
 * そのため `push` は本文を含む end_turn の行で「終わりの候補」を知らせるだけにし、
 * 呼び出し側が少し待って続きの行が来なくなってから `take` で本文を取り出す。
 * thinking の行は本文を含まないので候補にしない (候補にすると最後の本文が漏れる)。
 *
 * JSONL の中身をパースするのは type / stop_reason / content block の種別だけで、
 * 画面テキストの解釈は一切しない (CLAUDE.md の情報源分離の原則)。
 */

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

interface TranscriptRecord {
  type?: unknown;
  isSidechain?: unknown;
  message?: {
    stop_reason?: unknown;
    content?: unknown;
  };
}

/** end_turn で確定した 1 ターン分の本文 */
export interface AssembledTurn {
  text: string;
}

export class TurnAssembler {
  private buffer: string[] = [];
  /**
   * 会話の世代。ユーザーの新しい発話・/clear のたびに進む。
   * 判定の途中で会話が進んだら、その判定の結果を捨てるために使う
   */
  generation = 0;

  /** /clear 等で transcript が切り替わったとき */
  reset(): void {
    this.buffer = [];
    this.generation += 1;
  }

  /**
   * JSONL の生の 1 行を渡す。本文を含む end_turn の行なら true (返答が終わったかも
   * しれない。同じ返答の本文の行が続くことがあるので、確定は `take` で行う)。
   * パースできない行・関係ない行は黙って無視する。
   */
  push(raw: string): boolean {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(raw) as TranscriptRecord;
    } catch {
      return false;
    }
    if (!record || typeof record !== "object") return false;
    // subagent の transcript は本人の返答ではない
    if (record.isSidechain === true) return false;

    const content = record.message?.content;
    if (record.type === "user") {
      const isToolResult =
        Array.isArray(content) &&
        content.some(block => (block as ContentBlock)?.type === "tool_result");
      if (!isToolResult) {
        this.buffer = [];
        this.generation += 1;
      }
      return false;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) return false;

    let hasText = false;
    for (const block of content as ContentBlock[]) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        this.buffer.push(block.text);
        hasText = true;
      }
    }
    return record.message?.stop_reason === "end_turn" && hasText;
  }

  /** 溜めた本文をターンとして取り出す。無ければ null */
  take(): AssembledTurn | null {
    const text = this.buffer.join("\n\n").trim();
    this.buffer = [];
    return text ? { text } : null;
  }
}
