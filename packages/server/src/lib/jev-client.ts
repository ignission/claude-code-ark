/**
 * Jev (TypeSafe の決定モデル) を OpenRouter の Decisions API 経由で呼ぶ。
 *
 * Jev は文章を生成しない。テキストと型付きの質問を渡すと、選択肢の中から
 * 1 つを確率付きで返すだけの分類器で、1 回 200〜400ms・入力 100 万トークンで
 * $0.042 (出力は無料)。Ark はこれを「Claude の返答をボードへ出すべきか」の
 * 判定にだけ使い、本文の生成には使わない (Claude のトークンを消費しない)。
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

/** ボードに出すとき、本文をそのまま文書にするか、作図が要るか */
export type BoardForm = "doc" | "figure";

export interface BoardDecision {
  /** 「チャットよりボードのほうが読みやすい」の確率 (0〜1) */
  board: number;
  form: BoardForm;
  /** form=figure の確率 (0〜1) */
  figure: number;
  /** この呼び出しの費用 (USD)。usage が無ければ 0 */
  cost: number;
}

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

/** Jev へ送る質問。文言は検証スクリプトで 197 ターンに掛けて決めた */
export const BOARD_QUESTIONS = {
  board: {
    type: "noul",
    instructions:
      "This is one reply from an AI coding assistant in a chat. Would the reader understand it faster as a diagram or a structured document on a board than as chat text?",
    criteria: {
      true: "Explains relations among several components, a flow with branches, a comparison of options, or a multi-step plan; long enough that reading it as chat is tiring",
      false:
        "A short answer, a status update, a single conclusion, a question, or a code snippet that is fine as chat text",
    },
  },
  form: {
    type: "choice",
    instructions:
      "If this reply were moved to a board, which form fits it best?",
    criteria: {
      doc: "The text itself, kept as a readable document with headings, lists and tables; no drawing needed",
      figure:
        "A drawn figure is needed: a flow with branches, a state machine, relations among components, an architecture, a timeline",
    },
  },
} as const;

interface DecisionsResponse {
  answers?: {
    board?: { type?: string; noul?: unknown };
    form?: {
      type?: string;
      choice?: unknown;
      probabilities?: Record<string, unknown>;
    };
  };
  usage?: { cost?: unknown };
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
 * 1 ターン分の返答本文を Jev に判定させる。
 * 失敗 (HTTP エラー・timeout・想定外のレスポンス) は throw する。呼び出し側で握る。
 */
export async function decideBoardSuggestion(
  text: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<BoardDecision> {
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
        state: text.slice(-JEV_MAX_STATE_CHARS),
        questions: BOARD_QUESTIONS,
      }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Jev HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = JSON.parse(body) as DecisionsResponse;
    const board = asProbability(json.answers?.board?.noul);
    const figure = asProbability(json.answers?.form?.probabilities?.figure);
    const choice = json.answers?.form?.choice;
    if (
      board === null ||
      figure === null ||
      (choice !== "doc" && choice !== "figure")
    ) {
      throw new Error(`Jev の応答が想定外です: ${body.slice(0, 200)}`);
    }
    const cost = typeof json.usage?.cost === "number" ? json.usage.cost : 0;
    return { board, form: choice, figure, cost };
  } finally {
    clearTimeout(timer);
  }
}
