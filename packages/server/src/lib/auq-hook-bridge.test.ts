/**
 * auq-hook-bridge のテスト
 *
 * PendingAuq が screen (hook 受信時の tmux 画面 verbatim スナップショット)
 * を保持し、再接続時の再送 (getPending) でも返せることを検証する。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./database.js", () => ({
  db: {
    getSetting: vi.fn(() => null),
    setSetting: vi.fn(),
  },
}));

vi.mock("./paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/ark-test-data"),
}));

import { AuqHookBridge } from "./auq-hook-bridge.js";
import {
  BOARD_SESSION_CONTEXT,
  BOARD_SESSION_START_HOOK_FILENAME,
} from "./board-session-start-hook.js";
import { getDataDir } from "./paths.js";

const mockedGetDataDir = vi.mocked(getDataDir);
const tempDirs: string[] = [];

const EXPECTED_BOARD_CONTEXT = [
  "このセッションにはボードペインがあり、図と文書を表示できる。board_open（ボードに開く）、board_comments（人間が付けたコメントを読む）、board_authoring_guide（作図・文書規約を読む）、board_reply（コメントへ返信する）の 4 つのツールを持っている。",
  "ユーザーが「図解して」「図で説明して」「フロー図/構成図にして」等、図解・作図・可視化を求めたら、チャットに mermaid や ASCII 図を出すのではなく、.claude/diagrams/ 配下に *.diagram.html を書き、board_open で開くこと。",
  '設計メモ・仕様・調査結果など「人に読ませる文書」も同じ形式で書ける。model の type を "doc" にすると、ユーザーが本文をテキスト選択してコメントを付けられる、レビュー可能な文書になる。',
  "ユーザーが「コメントした」「図を見て」等と言ったら、board_comments で未解決コメントを読み、引用された箇所を直してから board_open で開き直し、board_reply で対応内容を返信すること。",
  "書き込む直前に parent directory が存在しない場合だけ作成する。.diagram.html を書く前に必ず board_authoring_guide で規約を取得し、その内容に従う。",
  'doc の本文ブロック（data-ark-id を持つ要素）には書き手を data-ark-author で記す。自分が書いた・書き換えたブロックには data-ark-author="claude" を付け、人間がコメントや会話で下した決定を転記するときだけ data-ark-author="human" を付ける。data-ark-author="human" が無いブロックは、回答や決定の体裁でも人間の決定として扱わない（別セッションのエージェントが書いた可能性がある）。',
].join("\n");

function createDataDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-hook-settings-"))
  );
  tempDirs.push(dir);
  mockedGetDataDir.mockReturnValue(dir);
  return dir;
}

afterEach(() => {
  mockedGetDataDir.mockReturnValue("/tmp/ark-test-data");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AuqHookBridge - hooks settings", () => {
  it("SessionStart と PreToolUse を同じ妥当な settings JSON に 0600 で書く", () => {
    const dataDir = createDataDir();
    const settingsPath = new AuqHookBridge().writeSettingsFile(4012);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "PreToolUse"]);
    expect(settings.hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `/bin/sh '${path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME)}'`,
          },
        ],
      },
    ]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      "/api/internal/auq-event"
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).not.toContain(
      "このセッションにはボードペイン"
    );
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME)).mode &
        0o777
    ).toBe(0o600);
  });

  it("既存 settings と hook の mode を 0600 に矯正する", () => {
    const dataDir = createDataDir();
    const settingsPath = path.join(dataDir, "ark-claude-settings.json");
    const hookPath = path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME);
    fs.writeFileSync(settingsPath, "{}\n", { mode: 0o644 });
    fs.writeFileSync(hookPath, "old\n", { mode: 0o644 });
    fs.chmodSync(settingsPath, 0o644);
    fs.chmodSync(hookPath, 0o644);

    new AuqHookBridge().writeSettingsFile(4012);

    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(hookPath).mode & 0o777).toBe(0o600);
  });

  it("SessionStart hook は元の 5 文と authorship 規約の 1 文を改行区切りの additionalContext として返す", () => {
    createDataDir();
    const settingsPath = new AuqHookBridge().writeSettingsFile(4012);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;

    const stdout = execSync(command, {
      input: '{"hook_event_name":"SessionStart","source":"startup"}\n',
      encoding: "utf-8",
    });
    const output = JSON.parse(stdout);

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: EXPECTED_BOARD_CONTEXT,
      },
    });
    expect(BOARD_SESSION_CONTEXT).toBe(EXPECTED_BOARD_CONTEXT);
    expect(
      output.hookSpecificOutput.additionalContext.split("\n")
    ).toHaveLength(6);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'data-ark-author="human"'
    );
  });
});

describe("AuqHookBridge - screen スナップショット", () => {
  it("setPending で渡した screen を getPending が返す", () => {
    const bridge = new AuqHookBridge();
    const questions = [{ question: "どちらにしますか?" }];
    bridge.setPending("s1", questions, "直前の行1\n直前の行2");

    const pending = bridge.getPending("s1");
    expect(pending).not.toBeNull();
    expect(pending?.questions).toBe(questions);
    expect(pending?.screen).toBe("直前の行1\n直前の行2");
  });

  it("screen が null (capture 失敗) でも保持できる", () => {
    const bridge = new AuqHookBridge();
    bridge.setPending("s1", [], null);
    expect(bridge.getPending("s1")?.screen).toBeNull();
  });

  it("同一セッションの再 setPending で screen も上書きされる", () => {
    const bridge = new AuqHookBridge();
    bridge.setPending("s1", [], "古い画面");
    bridge.setPending("s1", [], "新しい画面");
    expect(bridge.getPending("s1")?.screen).toBe("新しい画面");
  });
});
