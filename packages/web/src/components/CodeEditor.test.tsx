// @vitest-environment jsdom

import { undo } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodeEditor from "./CodeEditor";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

type Props = Parameters<typeof CodeEditor>[0];

async function setup(props: Partial<Props> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onSave = vi.fn();
  const render = (extra: Partial<Props> = {}) =>
    act(async () => {
      root.render(
        <CodeEditor
          filePath="notes.txt"
          value={"one\ntwo\nthree\n"}
          loadSeq={1}
          readOnly={false}
          revealSeq={0}
          onChange={onChange}
          onSave={onSave}
          {...props}
          {...extra}
        />
      );
    });
  mounted.push({ root, container });
  await render();
  const view = () => {
    const dom = container.querySelector<HTMLElement>(".cm-editor");
    const found = dom ? EditorView.findFromDOM(dom) : null;
    if (!found) throw new Error("EditorView がありません");
    return found;
  };
  return { container, onChange, onSave, render, view };
}

const targetLines = (view: EditorView) =>
  [...view.dom.querySelectorAll(".cm-ark-target-line")].map(
    el => el.textContent
  );

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom は Range.getClientRects を持たず、CodeMirror の計測 (rAF) が例外になる。
  // ここで見るのは状態と DOM だけなので、計測は走らせない
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("CodeEditor", () => {
  it("内容を出し、編集を onChange へ伝える", async () => {
    const t = await setup();
    const view = t.view();
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree\n");
    act(() => view.dispatch({ changes: { from: 0, insert: "zero\n" } }));
    expect(t.onChange).toHaveBeenLastCalledWith("zero\none\ntwo\nthree\n");
  });

  it("loadSeq が変わったときだけ文書を差し替え、view は作り直さない", async () => {
    const t = await setup();
    const view = t.view();
    act(() => view.dispatch({ selection: { anchor: 5 } }));

    // loadSeq が同じなら value が変わっても触らない
    await t.render({ value: "ignored\n" });
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree\n");

    await t.render({ value: "one\nTWO\nthree\nfour\n", loadSeq: 2 });
    expect(t.view()).toBe(view);
    expect(view.state.doc.toString()).toBe("one\nTWO\nthree\nfour\n");
    // 選択を保ち、読み直しは編集として伝えない
    expect(view.state.selection.main.anchor).toBe(5);
    expect(t.onChange).not.toHaveBeenCalled();

    // 短くなったら選択を文書の中へ収める
    await t.render({ value: "x", loadSeq: 3 });
    expect(view.state.selection.main.anchor).toBe(1);
  });

  it("読み直すと undo 履歴を捨てる (古い編集を新しい内容へ継ぎ足さない)", async () => {
    const t = await setup();
    const view = t.view();
    // 削除の取り消しは「消した文字の挿入」なので、履歴が残ると新しい内容へ混ざる
    act(() =>
      view.dispatch({
        changes: { from: 0, to: 4 },
        userEvent: "delete.backward",
      })
    );
    act(() =>
      view.dispatch({
        changes: { from: 0, insert: "typed " },
        userEvent: "input.type",
      })
    );
    await t.render({ value: "rewritten on disk\n", loadSeq: 2 });
    act(() => {
      undo(view);
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("rewritten on disk\n");
    expect(t.onChange).toHaveBeenCalledTimes(2);

    // 読み直したあとの編集は、これまでどおり取り消せる
    act(() =>
      view.dispatch({
        changes: { from: 0, insert: "again " },
        userEvent: "input.type",
      })
    );
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("rewritten on disk\n");
  });

  it("読み直しても言語・読み取り専用・行ハイライトを保つ", async () => {
    const t = await setup({
      filePath: "src/data.json",
      value: '{\n"a": 1\n}\n',
      readOnly: true,
      targetLine: 2,
    });
    const view = t.view();
    await vi.waitFor(() => {
      expect(view.state.facet(language)?.name).toBe("json");
    });
    await t.render({ value: '{\n"b": 2\n}\n', loadSeq: 2 });
    expect(view.state.facet(language)?.name).toBe("json");
    expect(view.state.readOnly).toBe(true);
    expect(targetLines(view)).toEqual(['"b": 2']);
    // 差し替えのあとも Compartment で切り替えられる
    await t.render({ value: '{\n"b": 2\n}\n', loadSeq: 2, readOnly: false });
    expect(view.state.readOnly).toBe(false);
  });

  it("Tab キーを奪わない (キーボードでエディタの外へ出られる)", async () => {
    const t = await setup();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      t.view().contentDOM.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(t.view().state.doc.toString()).toBe("one\ntwo\nthree\n");
  });

  it("CR と CRLF は改行として持ち、LF で返す", async () => {
    const t = await setup({ value: "a\r\nb\rc\n" });
    expect(t.view().state.doc.toString()).toBe("a\nb\nc\n");
  });

  it("readOnly を切り替えられる", async () => {
    const t = await setup({ readOnly: true });
    expect(t.view().state.readOnly).toBe(true);
    await t.render({ readOnly: false });
    expect(t.view().state.readOnly).toBe(false);
  });

  it("行指定をハイライトし、範囲と文書の差し替えに追従する", async () => {
    const t = await setup({ targetLine: 2 });
    const view = t.view();
    expect(targetLines(view)).toEqual(["two"]);

    // 逆順の範囲は入れ替える
    await t.render({ targetLine: 3, targetEndLine: 2, revealSeq: 1 });
    expect(targetLines(view)).toEqual(["two", "three"]);

    await t.render({
      targetLine: 3,
      targetEndLine: 2,
      revealSeq: 1,
      value: "a\nb\nc\nd\n",
      loadSeq: 2,
    });
    expect(targetLines(view)).toEqual(["b", "c"]);

    // 文書の外の行は無視する
    await t.render({ targetLine: 99, revealSeq: 2, loadSeq: 2 });
    expect(targetLines(view)).toEqual([]);
  });

  it("Mod-s で onSave を呼び、ブラウザの保存を止める", async () => {
    const t = await setup();
    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      t.view().contentDOM.dispatchEvent(event);
    });
    expect(t.onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ファイル名から言語を読み込む", async () => {
    const t = await setup({ filePath: "src/data.json", value: '{"a": 1}\n' });
    await vi.waitFor(() => {
      expect(t.view().state.facet(language)?.name).toBe("json");
    });
  });
});
