/**
 * ボード提案の設定 (有効 / 閾値 / Jev の API キー) の読み書き。
 *
 * 鍵は settings テーブルに平文で置く (単一ユーザー前提。data/ は gitignore 済み。
 * リモート画面の vncPassword と同じ扱い)。ただし `/api/settings` の全件取得や
 * キー指定の取得には返さない (`isSecretSettingKey`)。クライアントへは
 * `board-suggest:get` で「設定済みか」と末尾 4 文字だけを返す。
 *
 * 鍵の優先順: 設定画面 (settings) > 環境変数 OPENROUTER_API_KEY > ~/.config/openrouter/api-key
 */

import type { BoardSuggestConfig, BoardSuggestConfigPatch } from "@ark/shared";
import { loadOpenRouterApiKey } from "./jev-client.js";

export const BOARD_SUGGEST_SETTING_KEYS = {
  apiKey: "board_suggest_api_key",
  threshold: "board_suggest_threshold",
  enabled: "board_suggest_enabled",
} as const;

/** Jev の noul がこの値以上なら動く。0.5 付近は「分からない」なので高めに置く */
export const BOARD_SUGGEST_DEFAULT_THRESHOLD = 0.7;

/**
 * `/api/settings` に載せない設定キー。鍵やトークンはブラウザへ配る必要が無い
 * (auq_hook_token はセッション起動時に hook へ渡すだけ)
 */
export const SECRET_SETTING_KEYS: readonly string[] = [
  BOARD_SUGGEST_SETTING_KEYS.apiKey,
  "auq_hook_token",
];

export function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEYS.includes(key);
}

export interface SettingsReader {
  getSetting(key: string): unknown;
}

export interface ResolvedApiKey {
  key: string;
  source: "settings" | "env" | "file";
}

/** 使う鍵とその出どころ。無ければ null */
export function resolveBoardSuggestApiKey(
  settings: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): ResolvedApiKey | null {
  const saved = settings.getSetting(BOARD_SUGGEST_SETTING_KEYS.apiKey);
  if (typeof saved === "string" && saved.trim()) {
    return { key: saved.trim(), source: "settings" };
  }
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromFile = loadOpenRouterApiKey({}, homeDir);
  return fromFile ? { key: fromFile, source: "file" } : null;
}

export function readBoardSuggestThreshold(settings: SettingsReader): number {
  const saved = settings.getSetting(BOARD_SUGGEST_SETTING_KEYS.threshold);
  return typeof saved === "number" && saved >= 0 && saved <= 1
    ? saved
    : BOARD_SUGGEST_DEFAULT_THRESHOLD;
}

/** 既定は有効。明示的に false が保存されているときだけ止まる */
export function readBoardSuggestEnabled(settings: SettingsReader): boolean {
  return settings.getSetting(BOARD_SUGGEST_SETTING_KEYS.enabled) !== false;
}

/** クライアントに返す形。鍵そのものは含めない */
export function readBoardSuggestConfig(
  settings: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): BoardSuggestConfig {
  const resolved = resolveBoardSuggestApiKey(settings, env, homeDir);
  return {
    enabled: readBoardSuggestEnabled(settings),
    threshold: readBoardSuggestThreshold(settings),
    keyConfigured: resolved !== null,
    keyHint: resolved ? resolved.key.slice(-4) : null,
    keySource: resolved?.source ?? null,
  };
}

export type BoardSuggestPatchResult =
  | { ok: true; set: Record<string, unknown>; remove: string[] }
  | { ok: false; error: string };

/**
 * 設定画面からの変更を検証して、保存する entries と消すキーに分ける。
 * apiKey: 文字列なら保存 (前後の空白は落とす)、null なら設定側の鍵を消す
 * (環境変数やファイルの鍵は残る)、undefined なら触らない
 */
export function validateBoardSuggestPatch(
  patch: unknown
): BoardSuggestPatchResult {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "設定はオブジェクトで送ってください" };
  }
  const p = patch as BoardSuggestConfigPatch;
  const set: Record<string, unknown> = {};
  const remove: string[] = [];

  if (p.enabled !== undefined) {
    if (typeof p.enabled !== "boolean") {
      return { ok: false, error: "enabled は真偽値です" };
    }
    set[BOARD_SUGGEST_SETTING_KEYS.enabled] = p.enabled;
  }
  if (p.threshold !== undefined) {
    if (
      typeof p.threshold !== "number" ||
      !Number.isFinite(p.threshold) ||
      p.threshold < 0 ||
      p.threshold > 1
    ) {
      return { ok: false, error: "閾値は 0〜1 の数値です" };
    }
    set[BOARD_SUGGEST_SETTING_KEYS.threshold] = p.threshold;
  }
  if (p.apiKey !== undefined) {
    if (p.apiKey === null) {
      remove.push(BOARD_SUGGEST_SETTING_KEYS.apiKey);
    } else if (typeof p.apiKey !== "string") {
      return { ok: false, error: "API キーは文字列です" };
    } else {
      const trimmed = p.apiKey.trim();
      if (!trimmed) {
        return { ok: false, error: "API キーが空です" };
      }
      if (trimmed.length > 512 || /\s/.test(trimmed)) {
        return { ok: false, error: "API キーの形式が不正です" };
      }
      set[BOARD_SUGGEST_SETTING_KEYS.apiKey] = trimmed;
    }
  }
  return { ok: true, set, remove };
}
