// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramImageZoom, readDiagramImageMessage } from "./DiagramImageZoom";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("readDiagramImageMessage", () => {
  it("画像の data URL だけを受け取る", () => {
    expect(
      readDiagramImageMessage({ type: "ark:diagram-image", src: PNG, alt: "a" })
    ).toEqual({ src: PNG, alt: "a" });
    expect(
      readDiagramImageMessage({ type: "ark:diagram-image", src: PNG })
    ).toEqual({ src: PNG, alt: "" });
  });

  it("別の種類、data URL でない src、画像でない data URL は捨てる", () => {
    for (const data of [
      null,
      { type: "ark:diagram-scroll", x: 0, y: 0 },
      { type: "ark:diagram-image", src: "https://example.com/a.png" },
      { type: "ark:diagram-image", src: "javascript:alert(1)" },
      { type: "ark:diagram-image", src: "data:text/html,<p>x</p>" },
      { type: "ark:diagram-image", src: 1 },
    ]) {
      expect(readDiagramImageMessage(data)).toBeNull();
    }
  });
});

describe("DiagramImageZoom", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const overlay = () =>
    document.querySelector<HTMLElement>("[data-diagram-image-zoom]");

  it("画像を画面に重ねて出し、どこを押しても閉じる", () => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        <DiagramImageZoom image={{ src: PNG, alt: "画面" }} onClose={onClose} />
      )
    );

    const img = overlay()?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(PNG);
    expect(img?.getAttribute("alt")).toBe("画面");
    act(() => img?.click());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc で閉じ、閉じたらフォーカスを元へ戻す", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    act(() =>
      root.render(
        <DiagramImageZoom image={{ src: PNG, alt: "" }} onClose={onClose} />
      )
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("閉じる");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
