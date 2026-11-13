import { m } from "@/lib/i18n";

export interface BoardQuote {
  /** 一覧に出している図の名前 */
  name: string;
  relPath: string;
  /** 図の中で囲んだ範囲に見えていた文字。行は改行で区切られている */
  text: string;
  /** 上限で切られたか (diagram-select-layer.ts の DIAGRAM_SELECTION_TEXT_LIMIT) */
  truncated: boolean;
}

/**
 * ボードの一部を囲んだときに、会話の入力欄へ入れる下書き。
 *
 * どの図のどの部分かを Claude が図のファイルから探せるよう、ファイルのパスと、囲んだ文字を
 * 引用の形で入れる。末尾は空行で終え、続けて質問を書けるようにする。
 */
export function buildBoardQuoteDraft(quote: BoardQuote): string {
  const lines = quote.text.split("\n").map(line => `> ${line}`);
  if (quote.truncated) lines.push(`> ${m.board.quote.truncated}`);
  return `${m.board.quote.header(quote.name, quote.relPath)}\n${lines.join("\n")}\n\n`;
}
