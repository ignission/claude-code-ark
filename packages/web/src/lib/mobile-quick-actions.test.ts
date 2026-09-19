import { describe, expect, it } from "vitest";
import { mobileQuickActions } from "./mobile-quick-actions";

describe("mobileQuickActions", () => {
  it("アップロードできない環境では、ファイルの操作を出さない", () => {
    expect(
      mobileQuickActions({
        viewMode: "chat",
        canUploadFile: false,
        canCopyBuffer: false,
      })
    ).toEqual(["message-shortcuts", "slash-commands"]);
    expect(
      mobileQuickActions({
        viewMode: "terminal",
        canUploadFile: false,
        canCopyBuffer: false,
      })
    ).toEqual(["message-shortcuts", "slash-commands", "reload-terminal"]);
  });

  it("会話モードでは添付を出さない (会話の入力欄が自前のボタンを持つため)。画像の貼り付けは出す", () => {
    expect(
      mobileQuickActions({
        viewMode: "chat",
        canUploadFile: true,
        canCopyBuffer: true,
      })
    ).toEqual(["paste-image", "message-shortcuts", "slash-commands"]);
  });

  it("端末モードでは、添付・画像・ショートカット・スラッシュのあとに端末の操作を並べる", () => {
    expect(
      mobileQuickActions({
        viewMode: "terminal",
        canUploadFile: true,
        canCopyBuffer: true,
      })
    ).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
      "copy-buffer",
      "reload-terminal",
    ]);
  });

  it("端末モードでコピーができないときは、その1つだけを外す", () => {
    expect(
      mobileQuickActions({
        viewMode: "terminal",
        canUploadFile: true,
        canCopyBuffer: false,
      })
    ).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
      "reload-terminal",
    ]);
  });

  it("図モードの添付は端末モードと同じ流儀だが、端末の操作は出さない (端末が見えていない)", () => {
    expect(
      mobileQuickActions({
        viewMode: "board",
        canUploadFile: true,
        canCopyBuffer: true,
      })
    ).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });
  it("会話モードで音声が使えるときは、音声モードを先頭に出す", () => {
    expect(
      mobileQuickActions({
        viewMode: "chat",
        canUploadFile: true,
        canCopyBuffer: true,
        canUseVoice: true,
      })
    ).toEqual([
      "voice-mode",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });

  it("端末モードと図モードでは、音声が使えても音声モードを出さない", () => {
    for (const viewMode of ["terminal", "board"] as const) {
      expect(
        mobileQuickActions({
          viewMode,
          canUploadFile: false,
          canCopyBuffer: false,
          canUseVoice: true,
        })
      ).not.toContain("voice-mode");
    }
  });
});
