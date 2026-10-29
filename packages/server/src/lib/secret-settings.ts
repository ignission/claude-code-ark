/**
 * `/api/settings` に載せない設定キー。トークンはブラウザへ配る必要が無い
 * (auq_hook_token はセッション起動時に hook へ渡すだけ)
 */
export const SECRET_SETTING_KEYS: readonly string[] = ["auq_hook_token"];

export function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEYS.includes(key);
}

/**
 * 撤去した Jev 判定 (ボード提案と分岐TODOの自動検出) が使っていた設定キー。
 * OpenRouter の鍵を含むので、起動時に消して `/api/settings` に出さない
 */
export const RETIRED_SETTING_KEYS: readonly string[] = [
  "board_suggest_api_key",
  "board_suggest_enabled",
  "board_suggest_threshold",
  "branch_todo_enabled",
  "branch_todo_threshold",
];
