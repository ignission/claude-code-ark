/**
 * browser-protocolのテスト。
 */

import { describe, expect, it } from "vitest";
import { parseClientMessage, toCdpCommand } from "./browser-protocol.js";

describe("toCdpCommand", () => {
  const mouse = {
    t: "mouse",
    x: 10,
    y: 20,
    button: 0,
    buttons: 1,
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
    modifiers: 8,
  } as const;

  it("mouse downはmousePressedとleft", () => {
    expect(toCdpCommand({ ...mouse, type: "down" })).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 8,
      },
    });
  });

  it("mouse upはmouseReleased、範囲外のbuttonはnone", () => {
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 2 })?.params
    ).toMatchObject({ type: "mouseReleased", button: "right" });
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 1 })?.params
    ).toMatchObject({ button: "middle" });
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 9 })?.params
    ).toMatchObject({ button: "none" });
  });

  it("mouse moveのbuttonはbuttonsから決める", () => {
    expect(
      toCdpCommand({ ...mouse, type: "move", button: 0, buttons: 2 })?.params
    ).toMatchObject({ type: "mouseMoved", button: "right" });
    expect(
      toCdpCommand({ ...mouse, type: "move", buttons: 4 })?.params
    ).toMatchObject({ button: "middle" });
    expect(
      toCdpCommand({ ...mouse, type: "move", buttons: 0 })?.params
    ).toMatchObject({ button: "none" });
  });

  it("wheelはmouseWheelとdelta", () => {
    expect(
      toCdpCommand({
        ...mouse,
        type: "wheel",
        buttons: 0,
        deltaX: 1,
        deltaY: 120,
      })?.params
    ).toMatchObject({
      type: "mouseWheel",
      button: "none",
      deltaX: 1,
      deltaY: 120,
    });
  });

  it("textのあるkey downはkeyDown、無ければrawKeyDown、upはtextを落とす", () => {
    const key = {
      t: "key",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      repeat: false,
      modifiers: 0,
    } as const;
    expect(toCdpCommand({ ...key, type: "down", text: "a" })).toEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 0,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        text: "a",
        unmodifiedText: "a",
        autoRepeat: false,
      },
    });
    expect(toCdpCommand({ ...key, type: "down" })?.params).toMatchObject({
      type: "rawKeyDown",
    });
    const up = toCdpCommand({ ...key, type: "up", text: "a" })
      ?.params as Record<string, unknown>;
    expect(up.type).toBe("keyUp");
    expect(up.text).toBeUndefined();
  });

  it("imeとpaste", () => {
    expect(
      toCdpCommand({
        t: "ime",
        type: "update",
        text: "にほ",
        selectionStart: 2,
        selectionEnd: 2,
      })
    ).toEqual({
      method: "Input.imeSetComposition",
      params: { text: "にほ", selectionStart: 2, selectionEnd: 2 },
    });
    expect(toCdpCommand({ t: "ime", type: "commit", text: "日本" })).toEqual({
      method: "Input.insertText",
      params: { text: "日本" },
    });
    expect(toCdpCommand({ t: "ime", type: "cancel" })).toEqual({
      method: "Input.imeSetComposition",
      params: { text: "", selectionStart: 0, selectionEnd: 0 },
    });
    expect(toCdpCommand({ t: "paste", text: "x" })).toEqual({
      method: "Input.insertText",
      params: { text: "x" },
    });
  });

  it("resizeはnull", () => {
    expect(
      toCdpCommand({ t: "resize", width: 1, height: 1, dpr: 1, mobile: false })
    ).toBeNull();
  });
  it("refreshはnull", () => {
    expect(toCdpCommand({ t: "refresh" })).toBeNull();
  });

  it.each<[string, Parameters<typeof toCdpCommand>[0]]>([
    ["nav", { t: "nav", type: "goto", url: "http://localhost/" }],
    ["tab", { t: "tab", type: "new" }],
    ["dialog", { t: "dialog", accept: true }],
    ["copy", { t: "copy" }],
    ["selectChoose", { t: "selectChoose", id: 1, index: 0 }],
    ["selectCancel", { t: "selectCancel", id: 1 }],
  ])("%s はnull", (_name, msg) => {
    expect(toCdpCommand(msg)).toBeNull();
  });

  describe("タッチ", () => {
    it.each([
      ["start", "touchStart"],
      ["move", "touchMove"],
      ["end", "touchEnd"],
      ["cancel", "touchCancel"],
    ] as const)("%s を %s へ変換する", (type, cdpType) => {
      expect(
        toCdpCommand({
          t: "touch",
          type,
          points: [
            { id: 3, x: 10, y: 20 },
            { id: 0, x: 30, y: 40 },
          ],
          modifiers: 8,
        })
      ).toEqual({
        method: "Input.dispatchTouchEvent",
        params: {
          type: cdpType,
          touchPoints: [
            { x: 10, y: 20, id: 3 },
            { x: 30, y: 40, id: 0 },
          ],
          modifiers: 8,
        },
      });
    });

    it("指がすべて離れたendとcancelは、空の点の並びになる", () => {
      for (const type of ["end", "cancel"] as const) {
        expect(
          toCdpCommand({ t: "touch", type, points: [], modifiers: 0 })
        ).toEqual({
          method: "Input.dispatchTouchEvent",
          params: {
            type: type === "end" ? "touchEnd" : "touchCancel",
            touchPoints: [],
            modifiers: 0,
          },
        });
      }
    });

    it("座標を整数へ丸め、0から10000の間へ収める", () => {
      const command = toCdpCommand({
        t: "touch",
        type: "move",
        points: [
          { id: 0, x: 10.4, y: 20.5 },
          { id: 1, x: -5, y: 1e9 },
        ],
        modifiers: 0,
      });
      expect(command?.params).toMatchObject({
        touchPoints: [
          { x: 10, y: 21, id: 0 },
          { x: 0, y: 10000, id: 1 },
        ],
      });
    });
  });
});

describe("parseClientMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(parseClientMessage('{"t":"paste","text":"x"}')).toEqual({
      t: "paste",
      text: "x",
    });
  });

  it("知らない列は落とす", () => {
    expect(
      parseClientMessage('{"t":"ime","type":"cancel","method":"Browser.close"}')
    ).toEqual({ t: "ime", type: "cancel" });
  });

  it("refreshは、ほかの列を落として通す", () => {
    expect(parseClientMessage('{"t":"refresh"}')).toEqual({ t: "refresh" });
    expect(
      parseClientMessage('{"t":"refresh","method":"Browser.close"}')
    ).toEqual({ t: "refresh" });
  });

  it.each([
    ["壊れたJSON", "{"],
    ["オブジェクトでないJSON", "null"],
    ["未知のt", '{"t":"eval","code":"x"}'],
    [
      "数値でない座標",
      '{"t":"mouse","type":"down","x":"1","y":2,"button":0,"buttons":1,"clickCount":1,"deltaX":0,"deltaY":0,"modifiers":0}',
    ],
    [
      "未知のtype",
      '{"t":"mouse","type":"drag","x":1,"y":2,"button":0,"buttons":1,"clickCount":1,"deltaX":0,"deltaY":0,"modifiers":0}',
    ],
    ["文字列でないtext", '{"t":"paste","text":1}'],
    ["真偽値でないmobile", '{"t":"resize","width":1,"height":1,"dpr":1}'],
  ])("%s を拒否する", (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("長すぎるtextを拒否する", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ t: "paste", text: "a".repeat(100_001) })
      )
    ).toBeNull();
  });

  it("keyとcodeは64文字まで。textは長くてよい", () => {
    const key = {
      t: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      repeat: false,
      modifiers: 0,
    };
    const parse = (extra: object) =>
      parseClientMessage(JSON.stringify({ ...key, ...extra }));
    expect(parse({ key: "k".repeat(64), code: "c".repeat(64) })).not.toBeNull();
    expect(parse({ key: "k".repeat(65) })).toBeNull();
    expect(parse({ code: "c".repeat(65) })).toBeNull();
    expect(parse({ text: "t".repeat(100_000) })).not.toBeNull();
    expect(parse({ text: "t".repeat(100_001) })).toBeNull();
  });

  describe("ページの操作のメッセージ", () => {
    const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));
    const touch = {
      t: "touch",
      type: "move",
      points: [{ id: 0, x: 1.5, y: 2 }],
      modifiers: 8,
    };
    const points = (count: number) =>
      Array.from({ length: count }, (_, id) => ({ id, x: id, y: id }));

    it.each([
      [{ t: "nav", type: "goto", url: "localhost:3000" }],
      [{ t: "nav", type: "goto", url: "a".repeat(2048) }],
      [{ t: "nav", type: "back" }],
      [{ t: "nav", type: "forward" }],
      [{ t: "nav", type: "reload" }],
      [{ t: "nav", type: "stop" }],
      [{ t: "tab", type: "activate", id: "A1B2-c3" }],
      [{ t: "tab", type: "close", id: "a".repeat(64) }],
      [{ t: "tab", type: "new" }],
      [{ t: "dialog", accept: true }],
      [{ t: "dialog", accept: false, promptText: "p".repeat(10_000) }],
      [{ t: "copy" }],
      [{ t: "selectChoose", id: 0, index: 0 }],
      [{ t: "selectCancel", id: 3 }],
      [touch],
      [{ ...touch, type: "end", points: [] }],
      [{ ...touch, type: "start", points: points(10) }],
      [{ ...touch, type: "cancel" }],
    ])("%j を通す", value => {
      expect(parse(value)).toEqual(value);
    });

    it("知らない列は落とす", () => {
      expect(parse({ t: "nav", type: "back", url: "x", method: "m" })).toEqual({
        t: "nav",
        type: "back",
      });
      expect(parse({ t: "tab", type: "new", id: "T1" })).toEqual({
        t: "tab",
        type: "new",
      });
      expect(parse({ t: "copy", expression: "document.cookie" })).toEqual({
        t: "copy",
      });
      expect(
        parse({ ...touch, points: [{ id: 0, x: 1, y: 2, force: 9 }], extra: 1 })
      ).toEqual({ ...touch, points: [{ id: 0, x: 1, y: 2 }] });
    });

    it.each([
      [{ t: "nav", type: "goto" }],
      [{ t: "nav", type: "goto", url: 1 }],
      [{ t: "nav", type: "goto", url: "a".repeat(2049) }],
      [{ t: "nav", type: "home" }],
      [{ t: "nav" }],
      [{ t: "tab", type: "activate" }],
      [{ t: "tab", type: "activate", id: "" }],
      [{ t: "tab", type: "close", id: "a".repeat(65) }],
      [{ t: "tab", type: "close", id: "T1;x" }],
      [{ t: "tab", type: "close", id: 1 }],
      [{ t: "tab", type: "pin", id: "T1" }],
      [{ t: "dialog" }],
      [{ t: "dialog", accept: "yes" }],
      [{ t: "dialog", accept: true, promptText: 1 }],
      [{ t: "dialog", accept: true, promptText: "p".repeat(10_001) }],
      [{ t: "selectChoose", id: 1 }],
      [{ t: "selectChoose", id: -1, index: 0 }],
      [{ t: "selectChoose", id: 1, index: 0.5 }],
      [{ t: "selectChoose", id: 1, index: -1 }],
      [{ t: "selectChoose", id: "1", index: 0 }],
      [{ t: "selectCancel" }],
      [{ t: "selectCancel", id: 1.5 }],
      [{ ...touch, type: "tap" }],
      [{ ...touch, points: "x" }],
      [{ ...touch, points: points(11) }],
      [{ ...touch, points: [null] }],
      [{ ...touch, points: [{ id: 0, x: "1", y: 2 }] }],
      [{ ...touch, points: [{ id: 0, x: 1 }] }],
      [{ ...touch, points: [{ id: -1, x: 1, y: 2 }] }],
      [{ ...touch, points: [{ id: 0.5, x: 1, y: 2 }] }],
      [{ ...touch, modifiers: "0" }],
      [{ ...touch, modifiers: 16 }],
      [{ ...touch, modifiers: -1 }],
      [{ ...touch, modifiers: 0.5 }],
      [
        {
          ...touch,
          points: [
            { id: 1, x: 1, y: 2 },
            { id: 1, x: 3, y: 4 },
          ],
        },
      ],
      [{ ...touch, type: "start", points: [] }],
      [{ ...touch, type: "move", points: [] }],
    ])("%j を拒否する", value => {
      expect(parse(value)).toBeNull();
    });

    it("有限でない座標を拒否する", () => {
      expect(
        parseClientMessage(
          '{"t":"touch","type":"move","points":[{"id":0,"x":1e999,"y":2}],"modifiers":0}'
        )
      ).toBeNull();
    });
  });
});
