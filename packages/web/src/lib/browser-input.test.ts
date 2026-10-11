import { describe, expect, it } from "vitest";
import {
  isPasteShortcut,
  keyMessage,
  modifiersOf,
  mouseMessage,
  wheelMessage,
} from "./browser-input";

const key = {
  key: "a",
  code: "KeyA",
  keyCode: 65,
  repeat: false,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("modifiersOf", () => {
  it("CDPと同じビットにする", () => {
    expect(
      modifiersOf({
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      })
    ).toBe(1);
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      })
    ).toBe(2);
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      })
    ).toBe(4);
    expect(
      modifiersOf({
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      })
    ).toBe(15);
  });
});

describe("keyMessage", () => {
  it("文字のキーにはtextを付ける", () => {
    expect(keyMessage(key, "down")).toEqual({
      t: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
      repeat: false,
      modifiers: 0,
    });
  });
  it("EnterのtextはCR", () => {
    expect(
      keyMessage({ ...key, key: "Enter", code: "Enter", keyCode: 13 }, "down")
    ).toMatchObject({ text: "\r" });
  });
  it("CtrlかMetaを押した文字のキーにはtextを付けない (ショートカットとして届ける)", () => {
    expect(keyMessage({ ...key, ctrlKey: true }, "down")).not.toHaveProperty(
      "text"
    );
    expect(keyMessage({ ...key, metaKey: true }, "down")).not.toHaveProperty(
      "text"
    );
  });
  it("文字を生まないキーにはtextを付けない", () => {
    expect(
      keyMessage(
        { ...key, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
        "down"
      )
    ).not.toHaveProperty("text");
  });
  it("変換中のキーとIMEが受け取ったキー (229) は送らない", () => {
    expect(keyMessage({ ...key, isComposing: true }, "down")).toBeNull();
    expect(
      keyMessage({ ...key, key: "Process", keyCode: 229 }, "down")
    ).toBeNull();
  });
  it("upにはtextを付けない", () => {
    expect(keyMessage(key, "up")).not.toHaveProperty("text");
  });
});

describe("isPasteShortcut", () => {
  it("Ctrl+VとCmd+Vだけ", () => {
    expect(isPasteShortcut({ ...key, key: "v", ctrlKey: true })).toBe(true);
    expect(isPasteShortcut({ ...key, key: "V", metaKey: true })).toBe(true);
    expect(isPasteShortcut({ ...key, key: "v" })).toBe(false);
    expect(isPasteShortcut({ ...key, key: "c", ctrlKey: true })).toBe(false);
  });
});

describe("mouseMessage / wheelMessage", () => {
  const e = {
    clientX: 110,
    clientY: 220,
    button: 0,
    buttons: 1,
    detail: 2,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
  };
  it("原点を引いた座標とクリック回数を載せる", () => {
    expect(mouseMessage("down", e, { left: 10, top: 20 })).toEqual({
      t: "mouse",
      type: "down",
      x: 100,
      y: 200,
      button: 0,
      buttons: 1,
      clickCount: 2,
      deltaX: 0,
      deltaY: 0,
      modifiers: 8,
    });
  });
  it("moveのclickCountは0", () => {
    expect(mouseMessage("move", e, { left: 0, top: 0 })).toMatchObject({
      clickCount: 0,
    });
  });
  it("行単位のwheelをピクセルへ直す", () => {
    const w = { ...e, buttons: 0, deltaX: 0, deltaY: 3, deltaMode: 1 };
    expect(wheelMessage(w, { left: 0, top: 0 })).toMatchObject({
      type: "wheel",
      deltaY: 120,
    });
    expect(
      wheelMessage({ ...w, deltaMode: 0, deltaY: 53 }, { left: 0, top: 0 })
    ).toMatchObject({ deltaY: 53 });
  });
});
