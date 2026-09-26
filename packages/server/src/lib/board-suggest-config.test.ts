import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_SUGGEST_DEFAULT_THRESHOLD,
  BOARD_SUGGEST_SETTING_KEYS,
  isSecretSettingKey,
  readBoardSuggestConfig,
  resolveBoardSuggestApiKey,
  validateBoardSuggestPatch,
} from "./board-suggest-config.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function settingsOf(values: Record<string, unknown>) {
  return { getSetting: (key: string) => values[key] };
}

function emptyHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ark-bsc-home-"));
  tempDirs.push(home);
  return home;
}

describe("resolveBoardSuggestApiKey", () => {
  it("設定 > 環境変数 > ファイル の順で鍵を選ぶ", () => {
    const home = emptyHome();
    expect(resolveBoardSuggestApiKey(settingsOf({}), {}, home)).toBeNull();

    fs.mkdirSync(path.join(home, ".config", "openrouter"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openrouter", "api-key"),
      "sk-file\n"
    );
    expect(resolveBoardSuggestApiKey(settingsOf({}), {}, home)).toEqual({
      key: "sk-file",
      source: "file",
    });
    expect(
      resolveBoardSuggestApiKey(
        settingsOf({}),
        { OPENROUTER_API_KEY: "sk-env" },
        home
      )
    ).toEqual({ key: "sk-env", source: "env" });
    expect(
      resolveBoardSuggestApiKey(
        settingsOf({ [BOARD_SUGGEST_SETTING_KEYS.apiKey]: " sk-ui " }),
        { OPENROUTER_API_KEY: "sk-env" },
        home
      )
    ).toEqual({ key: "sk-ui", source: "settings" });
  });
});

describe("readBoardSuggestConfig", () => {
  it("鍵そのものは返さず、末尾 4 文字と出どころだけ返す", () => {
    const home = emptyHome();
    const config = readBoardSuggestConfig(
      settingsOf({
        [BOARD_SUGGEST_SETTING_KEYS.apiKey]: "sk-or-v1-abcdef1234",
      }),
      {},
      home
    );
    expect(config).toEqual({
      enabled: true,
      threshold: BOARD_SUGGEST_DEFAULT_THRESHOLD,
      keyConfigured: true,
      keyHint: "1234",
      keySource: "settings",
    });
    expect(JSON.stringify(config)).not.toContain("abcdef");
  });

  it("鍵が無ければ未設定、enabled=false と閾値は保存値を返す", () => {
    const home = emptyHome();
    expect(
      readBoardSuggestConfig(
        settingsOf({
          [BOARD_SUGGEST_SETTING_KEYS.enabled]: false,
          [BOARD_SUGGEST_SETTING_KEYS.threshold]: 0.85,
        }),
        {},
        home
      )
    ).toEqual({
      enabled: false,
      threshold: 0.85,
      keyConfigured: false,
      keyHint: null,
      keySource: null,
    });
  });
});

describe("validateBoardSuggestPatch", () => {
  it("鍵・閾値・有効を検証して保存/削除に分ける", () => {
    expect(
      validateBoardSuggestPatch({
        apiKey: " sk-x ",
        threshold: 0.8,
        enabled: false,
      })
    ).toEqual({
      ok: true,
      set: {
        [BOARD_SUGGEST_SETTING_KEYS.apiKey]: "sk-x",
        [BOARD_SUGGEST_SETTING_KEYS.threshold]: 0.8,
        [BOARD_SUGGEST_SETTING_KEYS.enabled]: false,
      },
      remove: [],
    });
    expect(validateBoardSuggestPatch({ apiKey: null })).toEqual({
      ok: true,
      set: {},
      remove: [BOARD_SUGGEST_SETTING_KEYS.apiKey],
    });
    expect(validateBoardSuggestPatch({})).toEqual({
      ok: true,
      set: {},
      remove: [],
    });
  });

  it("不正な値は理由つきで拒否する", () => {
    expect(validateBoardSuggestPatch(null).ok).toBe(false);
    expect(validateBoardSuggestPatch({ apiKey: "  " }).ok).toBe(false);
    expect(validateBoardSuggestPatch({ apiKey: "a b" }).ok).toBe(false);
    expect(validateBoardSuggestPatch({ apiKey: 1 }).ok).toBe(false);
    expect(validateBoardSuggestPatch({ threshold: 1.5 }).ok).toBe(false);
    expect(validateBoardSuggestPatch({ threshold: "0.7" }).ok).toBe(false);
    expect(validateBoardSuggestPatch({ enabled: "yes" }).ok).toBe(false);
  });
});

describe("isSecretSettingKey", () => {
  it("鍵と hook token を秘密として扱う", () => {
    expect(isSecretSettingKey(BOARD_SUGGEST_SETTING_KEYS.apiKey)).toBe(true);
    expect(isSecretSettingKey("auq_hook_token")).toBe(true);
    expect(isSecretSettingKey(BOARD_SUGGEST_SETTING_KEYS.threshold)).toBe(
      false
    );
    expect(isSecretSettingKey("scanBasePath")).toBe(false);
  });
});
