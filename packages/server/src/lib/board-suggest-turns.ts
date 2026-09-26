/**
 * JSONL transcript の行から「Claude の 1 ターン分の返答本文」を組み立てる。
 *
 * 対話版 claude は assistant の text block を 1 行ずつ書き、ツール呼び出しを
 * 挟みながら最後に `stop_reason: "end_turn"` の行でターンを終える。
 * ここでは直前のユーザー発話 (tool_result ではない user 行) 以降の text block を
 * すべて溜め、end_turn が来た時点で連結して 1 つの本文として返す。
 * この区切り方は Jev の検証スクリプトと同じにしてある (数値をそのまま持ち込むため)。
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

  /** /clear 等で transcript が切り替わったとき */
  reset(): void {
    this.buffer = [];
  }

  /**
   * JSONL の生の 1 行を渡す。ターンが確定したら本文を返し、それ以外は null。
   * パースできない行・関係ない行は黙って無視する。
   */
  push(raw: string): AssembledTurn | null {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(raw) as TranscriptRecord;
    } catch {
      return null;
    }
    if (!record || typeof record !== "object") return null;
    // subagent の transcript は本人の返答ではない
    if (record.isSidechain === true) return null;

    const content = record.message?.content;
    if (record.type === "user") {
      const isToolResult =
        Array.isArray(content) &&
        content.some(block => (block as ContentBlock)?.type === "tool_result");
      if (!isToolResult) this.buffer = [];
      return null;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) return null;

    for (const block of content as ContentBlock[]) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        this.buffer.push(block.text);
      }
    }
    if (record.message?.stop_reason !== "end_turn") return null;

    const text = this.buffer.join("\n\n").trim();
    this.buffer = [];
    return text ? { text } : null;
  }
}
