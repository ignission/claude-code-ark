/**
 * Jev (TypeSafe の決定モデル) を OpenRouter の Decisions API 経由で呼ぶ。
 *
 * Jev は文章を生成しない。テキストと型付きの質問を渡すと、選択肢の中から
 * 1 つを確率付きで返すだけの分類器で、1 回 200〜400ms・入力 100 万トークンで
 * $0.042 (出力は無料)。Ark はこれを「このターンに保留した話題があるか」の判定に使う
 * (branch-todo-stop-hook.ts)。TODO を書くのは Claude 自身。
 *
 * Decisions API は alpha (`/api/alpha/decisions`) で、パスやスキーマが変わりうる。
 * 変更点をここ 1 ファイルに閉じ込めるため、endpoint と model は定数にする。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const JEV_DECISIONS_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "~typesafe/jev-latest";

/** state に載せる本文の上限 (文字数)。Jev の context は 32k トークン */
export const JEV_MAX_STATE_CHARS = 6000;

const REQUEST_TIMEOUT_MS = 5000;

/**
 * API キーの所在。環境変数 OPENROUTER_API_KEY が優先、無ければ
 * ~/.config/openrouter/api-key (1 行) を読む。どちらも無ければ null。
 */
export function loadOpenRouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): string | null {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs
      .readFileSync(
        path.join(homeDir, ".config", "openrouter", "api-key"),
        "utf-8"
      )
      .trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

function asProbability(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Jev へ保留の判定を頼む質問。2026-10-26 に実際の会話 30 ターンと作った例 7 件で文言を決めた
 * (0.7 以上は 30 ターン中 1 件で、別件を保留した本物だけ。保留ありの例 0.75〜0.99、なしの例 0.03)。
 * 「同じ作業の次の手順」「CI 待ち」「ユーザーへの確認」を false に明記しないと、3 分の 1 のターンが立つ
 */
export const DEFERRED_QUESTIONS = {
  deferred: {
    type: "noul",
    instructions:
      "This is one turn of a chat between a user and an AI coding assistant. Did this turn push a separate topic aside — a different task, bug, question, or concern that came up but was explicitly postponed, declared out of scope, left for another change, or mentioned by the user and then not addressed — so that someone must remember to come back to it later?",
    criteria: {
      true: "A topic separate from the current work was raised and explicitly postponed, put off to another PR/change/session, declared out of scope, or ignored after the user mentioned it",
      false:
        "Everything raised was handled or is the current work in progress. Next steps of the same task, waiting for CI/review/deploy, asking the user to choose or confirm, and plans for the current feature do not count",
    },
  },
} as const;

export interface DeferredDecision {
  /** 「このターンに保留した話題がある」の確率 (0〜1) */
  deferred: number;
  cost: number;
}

const DEFERRED_PROMPT_MAX_CHARS = 2000;

/** Decisions API を 1 回呼び、answers と cost を返す。失敗は throw */
async function callDecisions(
  state: string,
  questions: unknown,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<{
  answers: Record<string, { noul?: unknown }>;
  cost: number;
  raw: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(JEV_DECISIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        // 会話本文を学習に使わせない
        provider: { data_collection: "deny" },
        state: state.slice(-JEV_MAX_STATE_CHARS),
        questions,
      }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Jev HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = JSON.parse(body) as {
      answers?: Record<string, { noul?: unknown }>;
      usage?: { cost?: unknown };
    };
    const cost = typeof json.usage?.cost === "number" ? json.usage.cost : 0;
    return { answers: json.answers ?? {}, cost, raw: body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1 ターン (人の発話 + 返答) に保留した話題があるかを Jev に判定させる。
 * 失敗 (HTTP エラー・timeout・想定外のレスポンス) は throw する。呼び出し側で握る。
 */
export async function decideDeferredTopic(
  prompt: string,
  reply: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<DeferredDecision> {
  // 発話とラベルの長さを先に確保し、残りの文字数で返答を末尾から切る (callDecisions の末尾 slice でラベルが消えないように)
  const head = `User: ${prompt.slice(-DEFERRED_PROMPT_MAX_CHARS)}\n\nAssistant: `;
  const room = Math.max(0, JEV_MAX_STATE_CHARS - head.length);
  const state = head + (room > 0 ? reply.slice(-room) : "");
  const { answers, cost, raw } = await callDecisions(
    state,
    DEFERRED_QUESTIONS,
    apiKey,
    fetchImpl
  );
  const deferred = asProbability(answers.deferred?.noul);
  if (deferred === null) {
    throw new Error(`Jev の応答が想定外です: ${raw.slice(0, 200)}`);
  }
  return { deferred, cost };
}
