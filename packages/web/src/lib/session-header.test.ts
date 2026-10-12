import { describe, expect, it } from "vitest";
import {
  deleteSessionDescription,
  inputBarToggleLabel,
  notificationMenuLabel,
  resolveSessionHeaderLabels,
  terminalWindowActions,
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

describe("terminalWindowActions", () => {
  it("端末の窓には、端末そのものを動かす操作を並べる", () => {
    expect(terminalWindowActions({ canCopyBuffer: true })).toEqual([
      "copy-buffer",
      "reload-terminal",
      "toggle-input-bar",
    ]);
  });

  it("コピーができないときは、その1つだけを外す", () => {
    expect(terminalWindowActions({ canCopyBuffer: false })).toEqual([
      "reload-terminal",
      "toggle-input-bar",
    ]);
  });
});

describe("inputBarToggleLabel", () => {
  it("今の状態ではなく、押すと起きることを書く", () => {
    expect(inputBarToggleLabel(true)).toBe("入力バーを隠す");
    expect(inputBarToggleLabel(false)).toBe("入力バーを表示");
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
