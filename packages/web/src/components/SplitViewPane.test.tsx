import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSplitViewLeftMode,
  readSavedSplitViewLeftMode,
  SPLIT_VIEW_LEFT_MODE_VALUES,
  shouldAcceptTerminalFileDrop,
  shouldSubscribeChat,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import {
  SPLIT_VIEW_LEFT_MODES,
  SplitViewLeftModeToggle,
} from "./SplitViewLeftModeToggle";

describe("PC 左ペインの表示モード", () => {
  it("terminal / chat を正規化し、不正値は terminal へ戻す", () => {
    expect(SPLIT_VIEW_LEFT_MODES.map(option => option.value)).toEqual([
      "terminal",
      "chat",
    ]);
    expect(normalizeSplitViewLeftMode("terminal")).toBe("terminal");
    expect(normalizeSplitViewLeftMode("chat")).toBe("chat");
    // モバイル側の値（board）は PC の左ペインには無い
    expect(normalizeSplitViewLeftMode("board")).toBe("terminal");
    expect(normalizeSplitViewLeftMode(null)).toBe("terminal");
    expect(normalizeSplitViewLeftMode(undefined)).toBe("terminal");
  });

  it("chat を永続化し、保存値から復元する", () => {
    const writer = { setItem: vi.fn() };

    writeSavedSplitViewLeftMode("chat", writer);

    expect(writer.setItem).toHaveBeenCalledWith("ark-split-left-mode", "chat");
    expect(readSavedSplitViewLeftMode({ getItem: () => "chat" })).toBe("chat");
  });

  it("保存が無いユーザーは従来どおりターミナルで開く", () => {
    expect(readSavedSplitViewLeftMode({ getItem: () => null })).toBe(
      "terminal"
    );
  });

  it("localStorage が使えなくても既定へ落ちて切替を壊さない", () => {
    const throwingReader = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    };
    const throwingWriter = {
      setItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(readSavedSplitViewLeftMode(throwingReader)).toBe("terminal");
    expect(() =>
      writeSavedSplitViewLeftMode("chat", throwingWriter)
    ).not.toThrow();
  });

  it("会話ビューの JSONL 購読は選択中セッションの会話モード 1 枚だけ", () => {
    // 全セッションぶんの SplitViewPane が常時マウントされ、さらに左ペインは
    // 端末・会話の両方をマウントしたままなので、両方の条件で絞らないと
    // セッション数ぶんの tail が走る
    expect(shouldSubscribeChat(true, "chat")).toBe(true);
    expect(shouldSubscribeChat(true, "terminal")).toBe(false);
    expect(shouldSubscribeChat(false, "chat")).toBe(false);
    expect(shouldSubscribeChat(false, "terminal")).toBe(false);
  });

  it("端末の window D&D も表示中の 1 枚だけが受け取る", () => {
    // 会話モードでチャット欄へ落としたファイルが裏の端末ペインへ二重に
    // 入らないこと（window リスナーは display:none でも発火する）
    expect(shouldAcceptTerminalFileDrop(true, "terminal")).toBe(true);
    expect(shouldAcceptTerminalFileDrop(true, "chat")).toBe(false);
    expect(shouldAcceptTerminalFileDrop(false, "terminal")).toBe(false);
    expect(shouldAcceptTerminalFileDrop(false, "chat")).toBe(false);
  });

  it("選択中セッションではどちらか一方だけが「表示中」になる", () => {
    // 2 つの述語は左ペインの排他な 2 モードに 1 対 1 で対応する。
    // 同時 true（二重動作）も、選択中なのに同時 false（どちらのペインも
    // 動いていない）も、モードを増やしたときに壊れる形なのでここで縛る
    // モードを増やしたら自動でこの検査の対象になるよう、定義から回す
    for (const mode of SPLIT_VIEW_LEFT_MODE_VALUES) {
      expect(shouldSubscribeChat(true, mode)).toBe(
        !shouldAcceptTerminalFileDrop(true, mode)
      );
      // 非選択セッションはどちらのペインも見えていない
      expect(shouldSubscribeChat(false, mode)).toBe(false);
      expect(shouldAcceptTerminalFileDrop(false, mode)).toBe(false);
    }
  });

  it("トグルは選択中のモードだけを aria-pressed で示す", () => {
    const html = renderToStaticMarkup(
      createElement(SplitViewLeftModeToggle, {
        value: "chat",
        onChange: () => {},
      })
    );

    expect(html).toContain('aria-label="会話"');
    expect(html).toContain('aria-label="端末"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // 会話が選択されている＝会話ボタンだけが pressed
    const chatButton = html.slice(html.indexOf('aria-label="会話"'));
    expect(chatButton.slice(0, 120)).toContain('aria-pressed="true"');
  });
});
