import { describe, expect, it } from "vitest";
import { mobileQuickActions } from "./mobile-quick-actions";

describe("mobileQuickActions", () => {
  it("アップロードできない環境では、ファイルの操作を出さない", () => {
    expect(
      mobileQuickActions({
        surface: "chat",
        canUploadFile: false,
      })
    ).toEqual(["message-shortcuts", "slash-commands"]);
    expect(
      mobileQuickActions({
        surface: "terminal",
        canUploadFile: false,
      })
    ).toEqual(["message-shortcuts", "slash-commands"]);
  });

  it("会話モードでは添付を出さない (会話の入力欄が自前のボタンを持つため)。画像の貼り付けは出す", () => {
    expect(
      mobileQuickActions({
        surface: "chat",
        canUploadFile: true,
      })
    ).toEqual(["paste-image", "message-shortcuts", "slash-commands"]);
  });

  it("端末の窓の行は、端末へ打ち込むための操作だけを並べる (コピーと再読み込みは窓の上端のバーにある)", () => {
    const actions = mobileQuickActions({
      surface: "terminal",
      canUploadFile: true,
    });

    expect(actions).toEqual([
      "attach-file",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });

  it("図モードの行は、端末の窓の行と同じ並びにする (添付は端末の流儀で受ける)", () => {
    expect(
      mobileQuickActions({
        surface: "board",
        canUploadFile: true,
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
        surface: "chat",
        canUploadFile: true,
        canUseVoice: true,
      })
    ).toEqual([
      "voice-mode",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });

  it("端末の窓と図モードでは、音声が使えても音声モードを出さない", () => {
    for (const surface of ["terminal", "board"] as const) {
      expect(
        mobileQuickActions({
          surface,
          canUploadFile: false,
          canUseVoice: true,
        })
      ).not.toContain("voice-mode");
    }
  });
});
