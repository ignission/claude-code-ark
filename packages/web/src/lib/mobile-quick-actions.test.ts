import { describe, expect, it } from "vitest";
import { mobileQuickActions } from "./mobile-quick-actions";

describe("mobileQuickActions", () => {
  it("アップロードできない環境では、ファイルの操作を出さない", () => {
    expect(
      mobileQuickActions({ viewMode: "chat", canUploadFile: false })
    ).toEqual(["message-shortcuts", "slash-commands"]);
    expect(
      mobileQuickActions({ viewMode: "terminal", canUploadFile: false })
    ).toEqual(["message-shortcuts", "slash-commands"]);
  });

  it("会話モードでは添付を出さない (会話の入力欄が自前のボタンを持つため)。画像の貼り付けは出す", () => {
    expect(
      mobileQuickActions({ viewMode: "chat", canUploadFile: true })
    ).toEqual(["paste-image", "message-shortcuts", "slash-commands"]);
  });

  it("端末モードでは、添付・画像・ショートカット・スラッシュコマンドの4つを出す", () => {
    expect(
      mobileQuickActions({ viewMode: "terminal", canUploadFile: true })
    ).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });

  it("図モードは端末モードと同じ (添付は端末側の確認ダイアログの流儀)", () => {
    expect(
      mobileQuickActions({ viewMode: "board", canUploadFile: true })
    ).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });
});
