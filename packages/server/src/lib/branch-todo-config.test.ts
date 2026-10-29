import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRANCH_TODO_DEFAULT_THRESHOLD,
  BRANCH_TODO_SETTING_KEYS,
  isSecretSettingKey,
  readBranchTodoConfig,
  readBranchTodoEnabled,
  readBranchTodoThreshold,
  resolveBranchTodoApiKey,
  validateBranchTodoPatch,
} from "./branch-todo-config.js";

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

describe("resolveBranchTodoApiKey", () => {
  it("設定 > 環境変数 > ファイル の順で鍵を選ぶ", () => {
    const home = emptyHome();
    expect(resolveBranchTodoApiKey(settingsOf({}), {}, home)).toBeNull();

    fs.mkdirSync(path.join(home, ".config", "openrouter"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openrouter", "api-key"),
      "sk-file\n"
    );
    expect(resolveBranchTodoApiKey(settingsOf({}), {}, home)).toEqual({
      key: "sk-file",
      source: "file",
    });
    expect(
      resolveBranchTodoApiKey(
        settingsOf({}),
        { OPENROUTER_API_KEY: "sk-env" },
        home
      )
    ).toEqual({ key: "sk-env", source: "env" });
    expect(
      resolveBranchTodoApiKey(
        settingsOf({ [BRANCH_TODO_SETTING_KEYS.apiKey]: " sk-ui " }),
        { OPENROUTER_API_KEY: "sk-env" },
        home
      )
    ).toEqual({ key: "sk-ui", source: "settings" });
  });
});

describe("readBranchTodoConfig", () => {
  it("鍵そのものは返さず、末尾 4 文字と出どころだけ返す", () => {
    const home = emptyHome();
    const config = readBranchTodoConfig(
      settingsOf({
        [BRANCH_TODO_SETTING_KEYS.apiKey]: "sk-or-v1-abcdef1234",
      }),
      {},
      home
    );
    expect(config).toEqual({
      todoEnabled: true,
      todoThreshold: BRANCH_TODO_DEFAULT_THRESHOLD,
      keyConfigured: true,
      keyHint: "1234",
      keySource: "settings",
    });
    expect(JSON.stringify(config)).not.toContain("abcdef");
  });

  it("鍵が無ければ未設定、有効と閾値は保存値を返す", () => {
    const home = emptyHome();
    expect(
      readBranchTodoConfig(
        settingsOf({
          [BRANCH_TODO_SETTING_KEYS.todoEnabled]: false,
          [BRANCH_TODO_SETTING_KEYS.todoThreshold]: 0.85,
        }),
        {},
        home
      )
    ).toEqual({
      todoEnabled: false,
      todoThreshold: 0.85,
      keyConfigured: false,
      keyHint: null,
      keySource: null,
    });
  });
});

describe("validateBranchTodoPatch", () => {
  it("鍵を検証して保存/削除に分ける", () => {
    expect(validateBranchTodoPatch({ apiKey: " sk-x " })).toEqual({
      ok: true,
      set: { [BRANCH_TODO_SETTING_KEYS.apiKey]: "sk-x" },
      remove: [],
    });
    expect(validateBranchTodoPatch({ apiKey: null })).toEqual({
      ok: true,
      set: {},
      remove: [BRANCH_TODO_SETTING_KEYS.apiKey],
    });
    expect(validateBranchTodoPatch({})).toEqual({
      ok: true,
      set: {},
      remove: [],
    });
  });

  it("分岐TODOの有効と閾値を検証して保存キーに分ける", () => {
    expect(
      validateBranchTodoPatch({ todoEnabled: false, todoThreshold: 0.8 })
    ).toEqual({
      ok: true,
      set: { branch_todo_enabled: false, branch_todo_threshold: 0.8 },
      remove: [],
    });
    expect(validateBranchTodoPatch({ todoThreshold: 2 })).toEqual({
      ok: false,
      error: "閾値は 0〜1 の数値です",
    });
    expect(validateBranchTodoPatch({ todoEnabled: "yes" })).toEqual({
      ok: false,
      error: "todoEnabled は真偽値です",
    });
  });

  it("不正な値は理由つきで拒否する", () => {
    expect(validateBranchTodoPatch(null).ok).toBe(false);
    expect(validateBranchTodoPatch({ apiKey: "  " }).ok).toBe(false);
    expect(validateBranchTodoPatch({ apiKey: "a b" }).ok).toBe(false);
    expect(validateBranchTodoPatch({ apiKey: 1 }).ok).toBe(false);
    expect(validateBranchTodoPatch({ todoThreshold: 1.5 }).ok).toBe(false);
    expect(validateBranchTodoPatch({ todoThreshold: "0.7" }).ok).toBe(false);
  });
});

describe("isSecretSettingKey", () => {
  it("鍵と hook token を秘密として扱う", () => {
    expect(isSecretSettingKey(BRANCH_TODO_SETTING_KEYS.apiKey)).toBe(true);
    expect(isSecretSettingKey("auq_hook_token")).toBe(true);
    expect(isSecretSettingKey(BRANCH_TODO_SETTING_KEYS.todoThreshold)).toBe(
      false
    );
    expect(isSecretSettingKey("scanBasePath")).toBe(false);
  });
});

describe("分岐TODOの設定", () => {
  it("分岐TODOは既定で有効、閾値は 0.7", () => {
    const settings = { getSetting: () => undefined };
    expect(readBranchTodoEnabled(settings)).toBe(true);
    expect(readBranchTodoThreshold(settings)).toBe(0.7);
  });
});
