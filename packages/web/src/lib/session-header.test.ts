import { describe, expect, it } from "vitest";
import {
  deleteSessionDescription,
  headerQuickActions,
  notificationMenuLabel,
  resolveSessionHeaderLabels,
  terminalMenuActions,
} from "./session-header";

describe("resolveSessionHeaderLabels", () => {
  const base = {
    displayName: null,
    repoName: "recipe-app",
    branch: "feature/login",
    worktreePath: "/work/recipe-app-login",
  };

  it("表示名があれば、前後の空白を落として主ラベルにする", () => {
    expect(
      resolveSessionHeaderLabels({ ...base, displayName: " ログイン画面 " })
    ).toEqual({ primary: "ログイン画面", branch: "feature/login" });
  });

  it("表示名が未設定か空白だけなら、リポジトリ名を主ラベルにする", () => {
    expect(resolveSessionHeaderLabels(base).primary).toBe("recipe-app");
    expect(
      resolveSessionHeaderLabels({ ...base, displayName: "  " }).primary
    ).toBe("recipe-app");
  });

  it("リポジトリ名もブランチも無ければ、worktreeのフォルダ名を使う", () => {
    expect(
      resolveSessionHeaderLabels({
        displayName: undefined,
        repoName: undefined,
        branch: undefined,
        worktreePath: "/work/recipe-app-login",
      })
    ).toEqual({ primary: "recipe-app-login", branch: "recipe-app-login" });
  });
});

describe("terminalMenuActions", () => {
  it("会話モードでは端末の操作を出さない", () => {
    expect(
      terminalMenuActions({ leftMode: "chat", canCopyBuffer: true })
    ).toEqual([]);
  });

  it("端末モードでは、コピー・再読み込み・入力バーの順に出す", () => {
    expect(
      terminalMenuActions({ leftMode: "terminal", canCopyBuffer: true })
    ).toEqual(["copy-buffer", "reload", "toggle-input-bar"]);
  });

  it("添付と画像の貼り付けは上部バーのボタンへ移したので、ここには出さない", () => {
    expect(
      terminalMenuActions({ leftMode: "terminal", canCopyBuffer: true })
    ).not.toContain("attach-file");
    expect(
      terminalMenuActions({ leftMode: "terminal", canCopyBuffer: true })
    ).not.toContain("paste-image");
  });

  it("コピーができないときは、その項目を外す", () => {
    expect(
      terminalMenuActions({ leftMode: "terminal", canCopyBuffer: false })
    ).toEqual(["reload", "toggle-input-bar"]);
  });
});

describe("headerQuickActions", () => {
  it("端末モードでは、添付・画像・ショートカットの順に出す", () => {
    expect(
      headerQuickActions({ leftMode: "terminal", canUploadFile: true })
    ).toEqual(["attach-file", "paste-image", "message-shortcuts"]);
  });

  it("会話モードの添付と画像は会話の入力欄が担うので、ショートカットだけ出す", () => {
    expect(
      headerQuickActions({ leftMode: "chat", canUploadFile: true })
    ).toEqual(["message-shortcuts"]);
  });

  it("アップロードできない環境では、端末モードでもショートカットだけ出す", () => {
    expect(
      headerQuickActions({ leftMode: "terminal", canUploadFile: false })
    ).toEqual(["message-shortcuts"]);
  });
});

describe("notificationMenuLabel", () => {
  it("今の設定を反転する操作として書く", () => {
    expect(notificationMenuLabel(true)).toBe(
      "このセッションの通知をオフにする"
    );
    expect(notificationMenuLabel(false)).toBe(
      "このセッションの通知をオンにする"
    );
  });
});

describe("deleteSessionDescription", () => {
  it("worktreeの有無とmainかどうかで本文を変える", () => {
    expect(deleteSessionDescription(undefined)).toBe(
      "このセッションを削除しますか？"
    );
    expect(deleteSessionDescription({ isMain: true })).toBe(
      "このセッションを削除しますか？メインWorktreeは削除されません。"
    );
    expect(deleteSessionDescription({ isMain: false })).toBe(
      "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"
    );
  });
});
