// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyImageToClipboard,
  diagramImageFileName,
  pngDataUrlToBlob,
  readDiagramCopyMessage,
} from "./board-copy-image";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("readDiagramCopyMessage", () => {
  it("画像と失敗を、頼んだときの番号と一緒に読み、ほかのメッセージは null にする", () => {
    expect(
      readDiagramCopyMessage({ type: "ark:diagram-copy", id: 2, dataUrl: PNG })
    ).toEqual({ kind: "picture", id: 2, dataUrl: PNG });
    expect(
      readDiagramCopyMessage({ type: "ark:diagram-copy-error", id: 3 })
    ).toEqual({ kind: "error", id: 3 });
    expect(
      readDiagramCopyMessage({
        type: "ark:diagram-copy",
        id: 4,
        dataUrl: "data:text/html,x",
      })
    ).toEqual({ kind: "error", id: 4 });
    expect(readDiagramCopyMessage({ type: "ark:diagram-sketch" })).toBeNull();
    expect(readDiagramCopyMessage(null)).toBeNull();
  });
});

describe("diagramImageFileName", () => {
  it("図のファイル名から .diagram.html を外して .png にする", () => {
    expect(diagramImageFileName(".claude/diagrams/flow.diagram.html")).toBe(
      "flow.png"
    );
    expect(diagramImageFileName("a.html")).toBe("a.png");
    expect(diagramImageFileName("")).toBe("board.png");
  });
});

describe("copyImageToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  it("押したその場で、画像になる前の Promise をクリップボードへ渡す", async () => {
    const write = vi.fn(async (items: unknown[]) => {
      const item = items[0] as { types: Record<string, Promise<Blob>> };
      await item.types["image/png"];
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public types: Record<string, Promise<Blob>>) {}
      }
    );
    let resolve: (blob: Blob) => void = () => {};
    const picture = new Promise<Blob>(r => {
      resolve = r;
    });
    const result = copyImageToClipboard(picture, "a.png");
    // 画像ができる前に書き込みが始まっている
    expect(write).toHaveBeenCalledTimes(1);
    resolve(pngDataUrlToBlob(PNG));
    await expect(result).resolves.toBe("copied");
  });

  it("クリップボードが無ければ、画像を保存させる", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await expect(
      copyImageToClipboard(Promise.resolve(pngDataUrlToBlob(PNG)), "a.png")
    ).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalled();
  });

  it("画像を作れなければ失敗にする", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await expect(
      copyImageToClipboard(Promise.reject(new Error("x")), "a.png")
    ).resolves.toBe("failed");
  });
});
