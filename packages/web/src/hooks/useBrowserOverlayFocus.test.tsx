// @vitest-environment jsdom

import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserOverlayFocus,
  LOCAL_INPUT_WINDOW_MS,
  useBrowserOverlayFocus,
} from "./useBrowserOverlayFocus";

let root: Root;
let container: HTMLDivElement;
let api: BrowserOverlayFocus;
let now = 1000;
/** 部品が、自分のeffectでフォーカスを動かす直前に呼んだ結果 */
let asked: Array<string | boolean> = [];

interface HarnessProps {
  /** 描く部品。無ければ描かない */
  overlay?: "dialog" | "select";
  canRestore?: boolean;
  /** URLの入力欄にあたる要素を描くか */
  withField?: boolean;
}

function Overlay({ kind }: { kind: "dialog" | "select" }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const answer =
      kind === "dialog" ? api.dialogFocusMode() : api.selectTakesFocus();
    asked.push(answer);
    if (answer !== false && answer !== "none") ref.current?.focus();
  }, [kind]);
  return (
    <div data-overlay>
      <button ref={ref} type="button" data-kind={kind}>
        部品
      </button>
    </div>
  );
}

function Harness({
  overlay,
  canRestore = true,
  withField = true,
}: HarnessProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  api = useBrowserOverlayFocus({
    paneRef,
    inputRef,
    shown: overlay !== undefined,
    canRestore,
    overlaySelector: "[data-overlay]",
  });
  return (
    <div ref={paneRef}>
      {withField && <input aria-label="URL" />}
      <textarea ref={inputRef} />
      {overlay && <Overlay key={overlay} kind={overlay} />}
    </div>
  );
}

function render(props: HarnessProps = {}) {
  act(() => root.render(<Harness {...props} />));
}

function field(): HTMLInputElement {
  return container.querySelector("input") as HTMLInputElement;
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

function part(): HTMLButtonElement {
  return container.querySelector("[data-overlay] button") as HTMLButtonElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  now = 1000;
  asked = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useBrowserOverlayFocus", () => {
  it("ダイアログは、透明の入力欄にフォーカスがあったときだけ、中の部品に置く", () => {
    act(() => textarea().focus());
    render({ overlay: "dialog" });
    expect(asked).toEqual(["control"]);

    render();
    expect(document.activeElement).toBe(textarea());
  });

  it("ダイアログは、ほかの場所にフォーカスがあったら枠に置き、閉じたらその場所へ戻す", () => {
    act(() => field().focus());
    render({ overlay: "dialog" });
    expect(asked).toEqual(["panel"]);
    expect(document.activeElement).toBe(part());

    render();
    expect(document.activeElement).toBe(field());
  });

  it("どこにもフォーカスが無かったら枠に置き、閉じたら透明の入力欄へ置く", () => {
    render({ overlay: "dialog" });
    expect(asked).toEqual(["panel"]);

    render();
    expect(document.activeElement).toBe(textarea());
  });

  it("ペインの外にフォーカスがあるとき、ダイアログはフォーカスを取らず、閉じても動かさない", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    render({ overlay: "dialog" });
    expect(asked).toEqual(["none"]);
    expect(document.activeElement).toBe(outside);

    render();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("ペインの外にフォーカスがあるとき、操作した直後でも選択リストはフォーカスを取らない", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    api.noteLocalInput();
    render({ overlay: "select" });
    expect(asked).toEqual([false]);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("戻す先がもう無ければ、透明の入力欄へ置く", () => {
    act(() => field().focus());
    render({ overlay: "dialog" });
    render({ overlay: "dialog", withField: false });
    render({ withField: false });

    expect(document.activeElement).toBe(textarea());
  });

  it("利用者がほかの欄へ移っていたら、閉じてもフォーカスを動かさない", () => {
    act(() => textarea().focus());
    render({ overlay: "dialog" });
    act(() => field().focus());
    render();

    expect(document.activeElement).toBe(field());
  });

  it("戻してよくない間 (隠れた、切れた) に閉じたら、フォーカスを動かさない", () => {
    act(() => textarea().focus());
    render({ overlay: "dialog" });
    render({ canRestore: false });
    expect(document.activeElement).not.toBe(textarea());

    // 次に出たときは、前に覚えた場所を使わない
    act(() => field().focus());
    render({ overlay: "dialog" });
    expect(asked).toEqual(["control", "panel"]);
  });

  it("選択リストは、ページを操作した直後に開いたときだけフォーカスを取る", () => {
    act(() => textarea().focus());
    render({ overlay: "select" });
    expect(asked).toEqual([false]);
    expect(document.activeElement).toBe(textarea());
    render();

    api.noteLocalInput();
    now += LOCAL_INPUT_WINDOW_MS;
    render({ overlay: "select" });
    expect(asked).toEqual([false, true]);
    expect(document.activeElement).toBe(part());
    render();
    expect(document.activeElement).toBe(textarea());

    now += 1;
    render({ overlay: "select" });
    expect(asked).toEqual([false, true, false]);
  });

  it("フォーカスを取らなかった部品が閉じても、フォーカスを動かさない", () => {
    render({ overlay: "select" });
    expect(document.activeElement).toBe(document.body);
    render();

    expect(document.activeElement).toBe(document.body);
  });

  it("選択リストに続いて出たダイアログは、リストが取る前の場所で置く先を決め、閉じたらそこへ戻す", () => {
    act(() => textarea().focus());
    api.noteLocalInput();
    render({ overlay: "select" });
    render({ overlay: "dialog" });
    expect(asked).toEqual([true, "control"]);

    render();
    expect(document.activeElement).toBe(textarea());
  });

  it("`StrictMode` でeffectが2回走っても、最初の場所を覚えている", () => {
    act(() => root.unmount());
    root = createRoot(container);
    const strict = (props: HarnessProps) =>
      act(() =>
        root.render(
          <StrictMode>
            <Harness {...props} />
          </StrictMode>
        )
      );
    strict({});
    act(() => textarea().focus());
    strict({ overlay: "dialog" });
    expect(asked).toEqual(["control", "control"]);

    strict({});
    expect(document.activeElement).toBe(textarea());
  });
});
