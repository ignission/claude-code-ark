import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failuresInboxPath,
  failuresPath,
  KNOWLEDGE_SESSION_START_HOOK_FILENAME,
  knowledgeDirectory,
  knowledgeSessionStartHookCommand,
  writeKnowledgeSessionStartHookFile,
} from "./knowledge-session-start-hook.js";

/**
 * SessionStart で渡すのは知識ファイルへの **ポインタ** だけである。
 * #367 の対照実験 (n=6) で効果を観測できたのはこの形なので、
 * 「パスが載ること」と「知識が無いときは黙ること」を固定する。
 */
describe("knowledge session start hook", () => {
  let home: string;
  let dataDir: string;
  const originalXdg = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ark-knowledge-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-knowledge-data-"));
    process.env.XDG_DATA_HOME = home;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const runHook = (hookPath: string): string =>
    execFileSync("/bin/sh", [hookPath], { encoding: "utf-8" });

  const writeFailures = (body: string): void => {
    fs.mkdirSync(knowledgeDirectory(), { recursive: true });
    fs.writeFileSync(failuresPath(), body);
  };

  it("failures.md があれば 2 つのパスと読む契機を additionalContext で返す", () => {
    writeFailures("### 既知の失敗\n");
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);

    const parsed = JSON.parse(runHook(hookPath));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context: string = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain(failuresPath());
    expect(context).toContain(failuresInboxPath());
    // 「いつ読むか」が無いと参照されない。パスだけを渡さないことを固定する。
    expect(context).toContain("作業開始前");
    // 中身は載せない (ポインタだけを渡す設計)
    expect(context).not.toContain("### 既知の失敗");
  });

  it("failures.md が無ければ何も出力しない", () => {
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);
    expect(runHook(hookPath)).toBe("");
  });

  it("failures.md が空なら何も出力しない", () => {
    writeFailures("");
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);
    expect(runHook(hookPath)).toBe("");
  });

  it("知識の有無は hook 実行時に見る (生成後に作られても拾う)", () => {
    // サーバー起動後に知識が生まれることがあるため、生成時点で判定してはいけない。
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);
    expect(runHook(hookPath)).toBe("");
    writeFailures("### あとから書いた\n");
    expect(runHook(hookPath)).not.toBe("");
  });

  it("hook は 0600 で置き、command にはパスだけを埋める", () => {
    writeFailures("### 既知の失敗\n");
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);

    expect(path.basename(hookPath)).toBe(KNOWLEDGE_SESSION_START_HOOK_FILENAME);
    expect(fs.statSync(hookPath).mode & 0o777).toBe(0o600);
    const command = knowledgeSessionStartHookCommand(hookPath);
    expect(command).toContain(hookPath);
    expect(command).not.toContain("作業開始前");
  });

  it("パスに single quote が含まれても壊れない", () => {
    process.env.XDG_DATA_HOME = path.join(home, "it's data");
    writeFailures("### 既知の失敗\n");
    const hookPath = writeKnowledgeSessionStartHookFile(dataDir);

    const parsed = JSON.parse(runHook(hookPath));
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      failuresPath()
    );
  });
});
