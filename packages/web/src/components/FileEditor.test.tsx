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
    await type(t.container, "a\nb\nc\n");
    await click(t.container, "保存");
    expect(f.write.mock.calls[0][1]).toBe("a\r\nb\r\nc\r\n");
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

  it("editable: false は読み取り専用で、保存できない", async () => {
    const f = makeApi(opened({ editable: false }));
    const t = await setup(f.api);
    expect(t.container.textContent).toContain("読み取り専用");
    expect(editor(t.container)?.dataset.readOnly).toBe("true");
    expect(button(t.container, "保存")).toBeUndefined();
    await pressSave(t.container);
    expect(f.write).not.toHaveBeenCalled();
  });

  it("非表示の間に届いた更新は、表示されたときに読み直す", async () => {
    const f = makeApi();
    const t = await setup(f.api, { isVisible: false });
    expect(f.open).toHaveBeenCalledTimes(1);
    f.setDisk(opened({ content: "later\n", mtimeMs: 300 }));
    await f.notify();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(editor(t.container)?.value).toBe("hello\n");

    await t.render({ isVisible: true });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(editor(t.container)?.value).toBe("later\n");
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
