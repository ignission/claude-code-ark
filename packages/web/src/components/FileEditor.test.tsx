// @vitest-environment jsdom

import type { FileOpenResponse, FileWriteResponse } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileApi } from "@/lib/file-api";
import type { FileTab } from "@/lib/file-tabs";
import { FileEditor } from "./FileEditor";

// CodeMirror は jsdom で測れないので textarea に差し替える。
// loadSeq が変わったら文書を差し替える、という契約だけを真似る
vi.mock("./CodeEditor", () => ({
  default: (props: {
    filePath: string;
    value: string;
    loadSeq: number;
    readOnly: boolean;
    targetLine?: number | null;
    revealSeq: number;
    onChange: (value: string) => void;
    onSave: () => void;
  }) => (
    <textarea
      key={props.loadSeq}
      data-testid="code-editor"
      data-read-only={String(props.readOnly)}
      data-target-line={String(props.targetLine ?? "")}
      data-reveal-seq={String(props.revealSeq)}
      defaultValue={props.value}
      onChange={e => props.onChange(e.target.value)}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") props.onSave();
      }}
    />
  ),
}));

vi.mock("./FileViewerPane", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
  ImageRenderer: ({ filePath }: { filePath: string }) => (
    <div data-testid="image">{filePath}</div>
  ),
}));

vi.mock("./HtmlViewerPane", () => ({
  HtmlViewerPane: ({ filePath }: { filePath: string }) => (
    <div data-testid="html">{filePath}</div>
  ),
}));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

const opened = (
  over: Partial<Extract<FileOpenResponse, { ok: true }>> = {}
): FileOpenResponse => ({
  ok: true,
  content: "hello\n",
  mimeType: "text/plain",
  size: 6,
  mtimeMs: 100,
  editable: true,
  ...over,
});

const tabOf = (over: Partial<FileTab> = {}): FileTab => ({
  id: "t1",
  kind: "file",
  filePath: "src/a.ts",
  revealSeq: 0,
  ...over,
});

function makeApi(initial: FileOpenResponse = opened()) {
  const state = { disk: initial, updated: null as null | (() => void) };
  const unsubscribe = vi.fn();
  const api = {
    open: vi.fn(async (_filePath: string) => state.disk),
    list: vi.fn(),
    write: vi.fn(
      async (
        _filePath: string,
        _content: string,
        _expectedMtimeMs: number,
        _force?: boolean
      ): Promise<FileWriteResponse> => ({ ok: true, mtimeMs: 200 })
    ),
    subscribe: vi.fn((_filePath: string, onUpdated: () => void) => {
      state.updated = onUpdated;
      return unsubscribe;
    }),
  };
  return {
    api: api as unknown as FileApi,
    open: api.open,
    write: api.write,
    subscribe: api.subscribe,
    unsubscribe,
    setDisk: (next: FileOpenResponse) => {
      state.disk = next;
    },
    /** サーバーからの file:updated を届ける */
    notify: async () => {
      await act(async () => {
        state.updated?.();
      });
      await flush();
    },
  };
}

/** lazy の解決と、ack の Promise を流しきる */
async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

async function setup(
  api: FileApi,
  props: Partial<Parameters<typeof FileEditor>[0]> = {}
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onDirtyChange = vi.fn();
  const onSaved = vi.fn();
  const render = async (
    extra: Partial<Parameters<typeof FileEditor>[0]> = {}
  ) => {
    await act(async () => {
      root.render(
        <FileEditor
          api={api}
          tab={tabOf()}
          isVisible
          onDirtyChange={onDirtyChange}
          onSaved={onSaved}
          {...props}
          {...extra}
        />
      );
    });
    await flush();
  };
  mounted.push({ root, container });
  await render();
  return { container, onDirtyChange, onSaved, render };
}

const editor = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>('[data-testid="code-editor"]');

const button = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find(
    b => b.getAttribute("aria-label") === label || b.textContent === label
  );

async function type(c: HTMLElement, value: string) {
  const el = editor(c);
  if (!el) throw new Error("エディタがありません");
  // React は value の setter を監視しているので、素の setter で書いてから input を投げる
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(c: HTMLElement, label: string) {
  const el = button(c, label);
  if (!el) throw new Error(`ボタンがありません: ${label}`);
  await act(async () => {
    el.click();
  });
  await flush();
}

async function pressSave(c: HTMLElement) {
  await act(async () => {
    editor(c)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })
    );
  });
  await flush();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("FileEditor", () => {
  it("chrome を渡すと、見出しの行にそれを載せ、ファイル名とパスは自分では出さない", async () => {
    const f = makeApi();
    const t = await setup(f.api, {
      chrome: {
        start: <span data-testid="chrome-start">PEEK</span>,
        end: (
          <button type="button" aria-label="閉じる">
            x
          </button>
        ),
      },
    });
    const start = t.container.querySelector('[data-testid="chrome-start"]');
    const row = start?.parentElement;
    expect(row).toBeTruthy();
    // 同じ行にサイズと保存ボタンと end が並ぶ (見出しは 1 段)
    expect(row?.textContent).toContain("6 B");
    expect(row?.querySelector('button[aria-label="保存"]')).not.toBeNull();
    expect(row?.querySelector('button[aria-label="閉じる"]')).not.toBeNull();
    expect(t.container.textContent).not.toContain("src/a.ts");
  });

  it("開けなかったときも chrome を出す (閉じるボタンを押せる)", async () => {
    const f = makeApi();
    f.setDisk({ ok: false, error: "見つかりません" });
    const t = await setup(f.api, {
      chrome: {
        start: <span>PEEK</span>,
        end: (
          <button type="button" aria-label="閉じる">
            x
          </button>
        ),
      },
    });
    expect(t.container.textContent).toContain("ファイルを開けません");
    expect(button(t.container, "閉じる")).toBeTruthy();
  });

  it("開くと内容が出て、更新を購読する", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    expect(f.open).toHaveBeenCalledWith("src/a.ts");
    expect(f.subscribe).toHaveBeenCalledWith("src/a.ts", expect.any(Function));
    expect(editor(t.container)?.value).toBe("hello\n");
    expect(t.container.textContent).toContain("src/a.ts");
    expect(t.container.textContent).toContain("6 B");
  });

  it("アンマウントで購読を解除する", async () => {
    const f = makeApi();
    await setup(f.api);
    const { root } = mounted[0];
    act(() => root.unmount());
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("行指定をエディタへ渡す", async () => {
    const f = makeApi();
    const t = await setup(f.api, {
      tab: tabOf({ targetLine: 12, revealSeq: 3 }),
    });
    expect(editor(t.container)?.dataset.targetLine).toBe("12");
    expect(editor(t.container)?.dataset.revealSeq).toBe("3");
  });

  it("編集すると dirty を伝え、元に戻すと解ける", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    expect(button(t.container, "保存")?.disabled).toBe(true);
    await type(t.container, "changed\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
    expect(button(t.container, "保存")?.disabled).toBe(false);
    await type(t.container, "hello\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
  });

  it("保存は読み取り時の mtime を添え、dirty が解ける", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "changed\n");
    await click(t.container, "保存");
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls[0].slice(0, 3)).toEqual([
      "src/a.ts",
      "changed\n",
      100,
    ]);
    expect(f.write.mock.calls[0][3]).toBeFalsy();
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
    expect(t.onSaved).toHaveBeenCalledTimes(1);

    // 自分の保存の反響は読み直さない (mtime は保存の応答で進んでいる)
    f.setDisk(opened({ content: "changed\n", mtimeMs: 200 }));
    await f.notify();
    expect(editor(t.container)?.value).toBe("changed\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");

    // 次の保存は新しい mtime を添える
    await type(t.container, "again\n");
    await pressSave(t.container);
    expect(f.write.mock.calls[1].slice(0, 3)).toEqual([
      "src/a.ts",
      "again\n",
      200,
    ]);
  });

  it("Ctrl+S でも保存する", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "x");
    await pressSave(t.container);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it("未編集なら Ctrl+S は何も書かない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await pressSave(t.container);
    expect(f.write).not.toHaveBeenCalled();
  });

  it("CRLF のファイルは LF で編集させ、CRLF で書き戻す", async () => {
    const f = makeApi(opened({ content: "a\r\nb\r\n" }));
    const t = await setup(f.api);
    expect(editor(t.container)?.value).toBe("a\nb\n");
    // 打ってから元へ戻すと、未保存の印が解ける
    await type(t.container, "a\nb\nc\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
    await type(t.container, "a\nb\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);

    await type(t.container, "a\nb\nc\n");
    await click(t.container, "保存");
    expect(f.write.mock.calls[0][1]).toBe("a\r\nb\r\nc\r\n");
  });

  it("単独の CR も改行として比べ、元へ戻すと dirty が解ける。保存は LF", async () => {
    // 最初の改行が CRLF でないので LF のファイルとして扱う
    const f = makeApi(opened({ content: "a\rb\nc\r\n" }));
    const t = await setup(f.api);
    // エディタ (CodeMirror) は CR を改行にして返す
    await type(t.container, "a\nb\nc\nd\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
    await type(t.container, "a\nb\nc\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);

    await type(t.container, "a\nb\nc\nd\n");
    await click(t.container, "保存");
    expect(f.write.mock.calls[0][1]).toBe("a\nb\nc\nd\n");
  });

  it("未編集で更新が届くと黙って読み直す", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    f.setDisk(opened({ content: "from claude\n", size: 12, mtimeMs: 300 }));
    await f.notify();
    expect(editor(t.container)?.value).toBe("from claude\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.container.textContent).toContain("12 B");
    // ツリーの git 状態も読み直させる
    expect(t.onSaved).toHaveBeenCalledTimes(1);
  });

  it("編集中に更新が届くとバナーを出し、「再読込」で編集を捨てる", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.setDisk(opened({ content: "theirs\n", mtimeMs: 300 }));
    await f.notify();
    expect(t.container.textContent).toContain("ディスク上で変更されました");
    expect(editor(t.container)?.value).toBe("mine\n");

    await click(t.container, "再読込 (編集を捨てる)");
    expect(editor(t.container)?.value).toBe("theirs\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
  });

  it("「このまま編集」はバナーだけ閉じる", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.setDisk(opened({ content: "theirs\n", mtimeMs: 300 }));
    await f.notify();
    await click(t.container, "このまま編集");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(editor(t.container)?.value).toBe("mine\n");
    expect(button(t.container, "保存")?.disabled).toBe(false);
  });

  it("保存が conflict なら「上書き保存」で force: true を送る", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.write.mockResolvedValueOnce({
      ok: false,
      code: "conflict",
      error: "ディスク上で変更されています",
      mtimeMs: 300,
    });
    await click(t.container, "保存");
    expect(t.container.textContent).toContain("ディスク上で変更されました");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);

    await click(t.container, "上書き保存");
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.write.mock.calls[1]).toEqual(["src/a.ts", "mine\n", 100, true]);
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
  });

  it("保存の失敗は理由を出し、編集を保つ", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.write.mockResolvedValueOnce({
      ok: false,
      code: "error",
      error: "書き込めません",
    });
    await click(t.container, "保存");
    expect(t.container.querySelector('[role="alert"]')?.textContent).toContain(
      "書き込めません"
    );
    expect(editor(t.container)?.value).toBe("mine\n");
    expect(button(t.container, "保存")?.disabled).toBe(false);
  });

  it("保存の応答を待つ間に届いた更新で、偽の競合を出さない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    let finish: (r: FileWriteResponse) => void = () => {};
    f.write.mockImplementationOnce(
      () => new Promise<FileWriteResponse>(resolve => (finish = resolve))
    );
    await click(t.container, "保存");
    // 応答より先に、自分の書き込みによる file:updated が届く
    f.setDisk(opened({ content: "mine\n", mtimeMs: 200 }));
    await f.notify();
    await act(async () => finish({ ok: true, mtimeMs: 200 }));
    await flush();
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(editor(t.container)?.value).toBe("mine\n");
  });

  it("保存の応答を待つ間に打った文字は、応答のあとも未保存のまま残る", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    let finish: (r: FileWriteResponse) => void = () => {};
    f.write.mockImplementationOnce(
      () => new Promise<FileWriteResponse>(resolve => (finish = resolve))
    );
    await click(t.container, "保存");
    await type(t.container, "mine\nmore\n");
    await act(async () => finish({ ok: true, mtimeMs: 200 }));
    await flush();
    expect(f.write.mock.calls[0][1]).toBe("mine\n");
    expect(editor(t.container)?.value).toBe("mine\nmore\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
    expect(button(t.container, "保存")?.disabled).toBe(false);

    // 続きの保存は、進んだ mtime を添える
    await click(t.container, "保存");
    expect(f.write.mock.calls[1]).toEqual(["src/a.ts", "mine\nmore\n", 200]);
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
  });

  it("保存の応答を待つ間は「再読込」が効かない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.setDisk(opened({ content: "theirs\n", mtimeMs: 300 }));
    await f.notify();
    let finish: (r: FileWriteResponse) => void = () => {};
    f.write.mockImplementationOnce(
      () => new Promise<FileWriteResponse>(resolve => (finish = resolve))
    );
    await click(t.container, "保存");
    const opens = f.open.mock.calls.length;
    const reloadButton = button(t.container, "再読込 (編集を捨てる)");
    expect(reloadButton?.disabled).toBe(true);
    await click(t.container, "再読込 (編集を捨てる)");
    expect(f.open).toHaveBeenCalledTimes(opens);
    expect(editor(t.container)?.value).toBe("mine\n");

    await act(async () =>
      finish({ ok: false, code: "conflict", error: "競合", mtimeMs: 300 })
    );
    await flush();
    expect(button(t.container, "再読込 (編集を捨てる)")?.disabled).toBe(false);
    expect(editor(t.container)?.value).toBe("mine\n");
  });

  it("保存より前に出した open が遅れて届いても、保存した内容を巻き戻さない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    // file:updated を受けて open したが、応答が遅れている
    let answer: (r: FileOpenResponse) => void = () => {};
    f.open.mockImplementationOnce(
      () => new Promise<FileOpenResponse>(resolve => (answer = resolve))
    );
    await f.notify();
    f.setDisk(opened({ content: "mine\n", mtimeMs: 200 }));
    await click(t.container, "保存");
    const opens = f.open.mock.calls.length;
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);

    // 書き込み前の内容が、いまごろ届く
    await act(async () => answer(opened()));
    await flush();
    expect(editor(t.container)?.value).toBe("mine\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
    // 捨てた open の代わりに、保存のあとで確かめ直している
    expect(opens).toBe(3);
  });

  it("保存の応答が無くても、書き込みが届いていれば保存済みにする", async () => {
    const f = makeApi(opened({ content: "a\r\nb\r\n" }));
    const t = await setup(f.api);
    await type(t.container, "a\nmine\n");
    f.write.mockImplementationOnce(async () => {
      // サーバーは書いたが、ack が届かなかった
      f.setDisk(opened({ content: "a\r\nmine\r\n", size: 11, mtimeMs: 250 }));
      return {
        ok: false,
        code: "error",
        error: "サーバーから応答がありません",
      };
    });
    await click(t.container, "保存");
    expect(t.container.querySelector('[role="alert"]')).toBeNull();
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", false);
    expect(t.onSaved).toHaveBeenCalledTimes(1);
    expect(t.container.textContent).toContain("11 B");
    expect(editor(t.container)?.value).toBe("a\nmine\n");

    // 自分の書き込みの file:updated を競合にしない
    await type(t.container, "a\nmine\nmore\n");
    await f.notify();
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    await click(t.container, "保存");
    expect(f.write.mock.calls[1]).toEqual([
      "src/a.ts",
      "a\r\nmine\r\nmore\r\n",
      250,
    ]);
  });

  it("失敗した保存があとから届いたら、ディスク上の変更として扱わない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    f.write.mockResolvedValueOnce({
      ok: false,
      code: "error",
      error: "サーバーから応答がありません",
    });
    await click(t.container, "保存");
    // 確かめた時点では、まだ書かれていない
    expect(t.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);

    await type(t.container, "mine\nmore\n");
    f.setDisk(opened({ content: "mine\n", size: 5, mtimeMs: 250 }));
    await f.notify();
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.container.querySelector('[role="alert"]')).toBeNull();
    // そのあとに打った分は未保存のまま
    expect(editor(t.container)?.value).toBe("mine\nmore\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
  });

  it("editable: false は読み取り専用で、保存できない", async () => {
    const f = makeApi(opened({ editable: false }));
    const t = await setup(f.api);
    expect(t.container.textContent).toContain("読み取り専用");
    expect(editor(t.container)?.dataset.readOnly).toBe("true");
    expect(button(t.container, "保存")).toBeUndefined();
    await pressSave(t.container);
    expect(f.write).not.toHaveBeenCalled();
  });

  it("非表示のタブは読まず、購読もしない。表示されたときに初めて開く", async () => {
    const f = makeApi();
    const t = await setup(f.api, { isVisible: false });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(editor(t.container)).toBeNull();

    await t.render({ isVisible: true });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    expect(editor(t.container)?.value).toBe("hello\n");
    // 初回の読み込みはツリーを読み直させない
    expect(t.onSaved).not.toHaveBeenCalled();
  });

  it("非表示になると購読を解除し、表示されると張り直す", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    expect(f.subscribe).toHaveBeenCalledTimes(1);

    await t.render({ isVisible: false });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    // 内容は保つ
    expect(editor(t.container)?.value).toBe("hello\n");

    await t.render({ isVisible: true });
    expect(f.subscribe).toHaveBeenCalledTimes(2);
  });

  it("非表示の間にディスクが変わっていたら、表示されたときに黙って読み直す", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await t.render({ isVisible: false });
    f.setDisk(opened({ content: "later\n", size: 6, mtimeMs: 300 }));
    expect(f.open).toHaveBeenCalledTimes(1);

    await t.render({ isVisible: true });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(editor(t.container)?.value).toBe("later\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.onSaved).toHaveBeenCalledTimes(1);
  });

  it("非表示の間もディスクが変わっていなければ、表示されても何も変えない", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    await t.render({ isVisible: false });

    await t.render({ isVisible: true });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(editor(t.container)?.value).toBe("mine\n");
    expect(t.container.textContent).not.toContain("ディスク上で変更されました");
    expect(t.onSaved).not.toHaveBeenCalled();
  });

  it("未保存のまま非表示の間にディスクが変わっていたら、表示されたときにバナーを出し、編集は保つ", async () => {
    const f = makeApi();
    const t = await setup(f.api);
    await type(t.container, "mine\n");
    await t.render({ isVisible: false });
    expect(editor(t.container)?.value).toBe("mine\n");
    f.setDisk(opened({ content: "theirs\n", mtimeMs: 300 }));

    await t.render({ isVisible: true });
    expect(t.container.textContent).toContain("ディスク上で変更されました");
    expect(editor(t.container)?.value).toBe("mine\n");
    expect(t.onDirtyChange).toHaveBeenLastCalledWith("t1", true);
  });

  it("開けなかったタブは、表示し直すと読み直す", async () => {
    const f = makeApi({ ok: false, error: "ファイルが見つかりません" });
    const t = await setup(f.api);
    expect(t.container.textContent).toContain("ファイルを開けません");

    await t.render({ isVisible: false });
    f.setDisk(opened());
    await t.render({ isVisible: true });
    expect(editor(t.container)?.value).toBe("hello\n");
  });

  it("開けないときは理由を出し、「再試行」で読み直す", async () => {
    const f = makeApi({ ok: false, error: "ファイルが見つかりません" });
    const t = await setup(f.api);
    expect(t.container.textContent).toContain("ファイルを開けません");
    expect(t.container.textContent).toContain("ファイルが見つかりません");
    expect(editor(t.container)).toBeNull();

    f.setDisk(opened());
    await click(t.container, "再試行");
    expect(editor(t.container)?.value).toBe("hello\n");
  });

  it("Markdown は既定でプレビューし、「編集」でエディタに切り替わる", async () => {
    const f = makeApi(
      opened({ content: "# 見出し\n", mimeType: "text/markdown" })
    );
    const t = await setup(f.api, { tab: tabOf({ filePath: "README.md" }) });
    expect(
      t.container.querySelector('[data-testid="markdown"]')?.textContent
    ).toBe("# 見出し\n");
    expect(editor(t.container)).toBeNull();

    await click(t.container, "編集");
    expect(editor(t.container)?.value).toBe("# 見出し\n");
    await type(t.container, "# 直した\n");

    // プレビューへ戻しても編集は残り、プレビューは編集中の内容を映す
    await click(t.container, "プレビュー");
    expect(
      t.container.querySelector('[data-testid="markdown"]')?.textContent
    ).toBe("# 直した\n");
    await click(t.container, "編集");
    expect(editor(t.container)?.value).toBe("# 直した\n");
  });

  it("行指定つきの Markdown は編集で開き、行をエディタへ渡す", async () => {
    const f = makeApi(
      opened({ content: "# 見出し\n", mimeType: "text/markdown" })
    );
    const t = await setup(f.api, {
      tab: tabOf({ filePath: "README.md", targetLine: 10 }),
    });
    expect(t.container.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(editor(t.container)?.dataset.targetLine).toBe("10");
    expect(button(t.container, "編集")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("プレビュー中の Markdown も、行指定で開き直されるたびに編集へ戻す", async () => {
    const f = makeApi(
      opened({ content: "# 見出し\n", mimeType: "text/markdown" })
    );
    const t = await setup(f.api, {
      tab: tabOf({ filePath: "README.md", targetLine: 10 }),
    });
    await click(t.container, "プレビュー");
    expect(
      t.container.querySelector('[data-testid="markdown"]')
    ).not.toBeNull();

    await t.render({
      tab: tabOf({ filePath: "README.md", targetLine: 24, revealSeq: 1 }),
    });
    expect(t.container.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(editor(t.container)?.dataset.targetLine).toBe("24");
    expect(editor(t.container)?.closest(".hidden")).toBeNull();

    // 行指定の無い開き直し (ツリーから選ぶなど) では、表示を変えない
    await click(t.container, "プレビュー");
    await t.render({
      tab: tabOf({ filePath: "README.md", revealSeq: 2 }),
    });
    expect(
      t.container.querySelector('[data-testid="markdown"]')
    ).not.toBeNull();
  });

  it("画像は ImageRenderer で出す", async () => {
    const f = makeApi(
      opened({
        content: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        editable: false,
      })
    );
    const t = await setup(f.api, { tab: tabOf({ filePath: "a.png" }) });
    expect(t.container.querySelector('[data-testid="image"]')).not.toBeNull();
    expect(editor(t.container)).toBeNull();
  });

  it("画像でないバイナリは、空のエディタではなく表示できない旨を出す", async () => {
    const f = makeApi(
      opened({
        content: "",
        mimeType: "application/octet-stream",
        size: 2048,
        editable: false,
      })
    );
    const t = await setup(f.api, { tab: tabOf({ filePath: "bin/tool" }) });
    expect(t.container.textContent).toContain("このファイルは表示できません");
    expect(t.container.textContent).toContain("2.0 KB");
    expect(editor(t.container)).toBeNull();
  });

  it("空のテキストファイルはエディタで開く", async () => {
    const f = makeApi(opened({ content: "", size: 0 }));
    const t = await setup(f.api);
    expect(editor(t.container)?.value).toBe("");
    expect(t.container.textContent).not.toContain(
      "このファイルは表示できません"
    );
  });

  it("html タブは HtmlViewerPane に任せ、file:open は呼ばない", async () => {
    const f = makeApi();
    const t = await setup(f.api, {
      tab: tabOf({ kind: "html", filePath: "/tmp/report.html" }),
    });
    expect(t.container.querySelector('[data-testid="html"]')?.textContent).toBe(
      "/tmp/report.html"
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });
});
