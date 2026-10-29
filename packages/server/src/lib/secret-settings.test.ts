import { describe, expect, it } from "vitest";
import { isSecretSettingKey, RETIRED_SETTING_KEYS } from "./secret-settings.js";

describe("isSecretSettingKey", () => {
  it("hook のトークンと撤去した設定を秘密として扱う", () => {
    expect(isSecretSettingKey("auq_hook_token")).toBe(true);
    expect(isSecretSettingKey("board_suggest_api_key")).toBe(true);
    expect(isSecretSettingKey("theme")).toBe(false);
  });

  it("撤去した設定に OpenRouter の鍵を含める (起動時に消すため)", () => {
    expect(RETIRED_SETTING_KEYS).toContain("board_suggest_api_key");
  });
});
