// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GitDiffView from "./GitDiffView";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function setup(props: Parameters<typeof GitDiffView>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = (next: Parameters<typeof GitDiffView>[0]) =>
    act(async () => {
      root.render(<GitDiffView {...next} />);
    });
  await render(props);
  const view = () => {
    const dom = container.querySelector<HTMLElement>(".cm-editor");
    const found = dom ? EditorView.findFromDOM(dom) : null;
    if (!found) throw new Error("EditorView がありません");
    return found;
  };
  return { container, render, view };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom は Range.getClientRects を持たず、CodeMirror の計測 (rAF) が例外になる
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("GitDiffView", () => {
  it("変更後を本文に置き、消えた行を上に差し込み、増えた行に印を付ける", async () => {
    const { container, view } = await setup({
      path: "notes.txt",
      oldContent: "one\ntwo\nthree\n",
      newContent: "one\nTWO\nthree\nfour\n",
    });
    expect(view().state.doc.toString()).toBe("one\nTWO\nthree\nfour\n");
    expect(view().state.readOnly).toBe(true);
    expect(container.querySelector(".cm-deletedChunk")?.textContent).toContain(
      "two"
    );
    expect(
      [...container.querySelectorAll(".cm-changedLine")].map(
        el => el.textContent
      )
    ).toEqual(["TWO", "four"]);
    // 取り込み / 取り消しのボタンは出さない
    expect(container.querySelector(".cm-chunkButtons")).toBeNull();
  });

  it("内容が変わったら view を作り直す", async () => {
    const { render, view } = await setup({
      path: "a.txt",
      oldContent: "a\n",
      newContent: "b\n",
    });
    const first = view();
    await render({ path: "a.txt", oldContent: "a\n", newContent: "c\n" });
    expect(view()).not.toBe(first);
    expect(view().state.doc.toString()).toBe("c\n");
  });
});
