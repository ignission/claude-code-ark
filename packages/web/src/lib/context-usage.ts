/**
 * セッションのコンテキストの使用量を、JSONLのassistant行の `message.usage` から読む。
 *
 * 使用量は「最後にClaudeへ送った入力の大きさ」で、input + cache_creation + cache_read の和。
 * 出力トークンは次のターンの入力に入るまで数えない (Claude Codeの /context と同じ見方)。
 * subagentの行 (isSidechain) は別の文脈なので数えない。
 *
 * 上限 (window) はJSONLに記録が無いので推定する。
 *  - `requestedModel` か `message.model` に `[1m]` が付いていれば100万
 *  - それ以外は20万。ただし使用量が20万を超えていれば100万 (`[1m]` を記録しない古い版の行)
 *
 * /compact の要約行で使用量を捨てる (要約後の次の返答まで、古い値を出し続けないため)。
 * /clear はファイルが替わり、空のsnapshotが届くので、呼び出し側で捨てる。
 */

export interface ContextUsage {
  /** 使用中のトークン数 */
  tokens: number;
  /** 推定した上限のトークン数 */
  window: number;
}

/** 1行を読んだ結果。`reset` は使用量を捨てる合図、null は使用量に関係しない行 */
export type ContextUsageUpdate = ContextUsage | "reset" | null;

const DEFAULT_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;

interface RawUsageLine {
  type?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  requestedModel?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function estimateWindow(tokens: number, models: unknown[]): number {
  const has1m = models.some(m => typeof m === "string" && m.includes("[1m]"));
  if (has1m || tokens > DEFAULT_WINDOW) return EXTENDED_WINDOW;
  return DEFAULT_WINDOW;
}

export function readContextUsage(raw: string): ContextUsageUpdate {
  if (!raw) return null;
  let obj: RawUsageLine;
  try {
    obj = JSON.parse(raw) as RawUsageLine;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.isSidechain === true) return null;
  if (obj.type === "user" && obj.isCompactSummary === true) return "reset";
  if (obj.type !== "assistant" || obj.message?.role !== "assistant") {
    return null;
  }
  const usage = obj.message.usage;
  if (!usage || typeof usage !== "object") return null;
  const tokens =
    count(usage.input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.cache_read_input_tokens);
  // usageの無いストリーミング途中の行や合成の行 (0) は、使用量を変えない
  if (tokens === 0) return null;
  return {
    tokens,
    window: estimateWindow(tokens, [obj.requestedModel, obj.message.model]),
  };
}

/** 行を古い順に読み、最後の使用量を返す (snapshot用) */
export function latestContextUsage(lines: string[]): ContextUsage | null {
  let current: ContextUsage | null = null;
  for (const line of lines) {
    const update = readContextUsage(line);
    if (update === "reset") current = null;
    else if (update) current = update;
  }
  return current;
}
