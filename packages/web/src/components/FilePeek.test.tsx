// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@/lib/file-tabs";
import { FilePeek, type FilePeekTarget } from "./FilePeek";

const createFileApi = vi.hoisted(() =>
  vi.fn((_socket: unknown, sessionId: string) => ({ sessionId }))
);
vi.mock("@/lib/file-api", () => ({ createFileApi }));

const editorMounts = vi.hoisted(() => ({ count: 0 }));

// FileEditor の振る舞いは FileEditor.test.tsx で見る。ここでは渡したタブと dirty の合図だけ見る
vi.mock("./FileEditor", async () => {
  const { useEffect } = await import("react");
  return {
    FileEditor: (props: {
      tab: FileTab;
      isVisible: boolean;
      onDirtyChange: (tabId: string, dirty: boolean) => void;
    }) => {
      const { onDirtyChange, tab } = props;
      useEffect(() => {
        editorMounts.count += 1;
        // 本物と同じく、外れるときに未保存の印を解く
        return () => onDirtyChange(tab.id, false);
      }, [onDirtyChange, tab.id]);
      return (
        <div
          data-testid="file-editor"
          data-tab={JSON.stringify(props.tab)}
          data-visible={String(props.isVisible)}
        >
          <button type="button" onClick={() => onDirtyChange(tab.id, true)}>
            dirty
          </button>
          <button type="button" onClick={() => onDirtyChange(tab.id, false)}>
            clean
          </button>
        </div>
      );
    },
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof FilePeek>;

const socket = {} as NonNullable<Props["socket"]>;
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function peekOf(
  filePath: string,
  seq: number,
  targetLine?: number
): FilePeekTarget {
  return { filePath, seq, targetLine, targetEndLine: undefined };
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    socket,
    sessionId: "s1",
    peek: peekOf("src/a.ts", 1, 10),
    isVisible: true,
    onClose: vi.fn(),
    onPromote: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<FilePeek {...props} />));
  mounted.push({ root, container });
  return {
    container,
    props,
    rerender: (next: Partial<Props>) =>
      act(() => root.render(<FilePeek {...props} {...next} />)),
  };
}

function click(scope: ParentNode, label: string) {
  const button =
    scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    Array.from(scope.querySelectorAll("button")).find(
      b => b.textContent === label
    );
  expect(button).toBeTruthy();
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function shownTab(scope: ParentNode): FileTab {
  const el = scope.querySelector<HTMLElement>('[data-testid="file-editor"]');
  expect(el).not.toBeNull();
  return JSON.parse(el?.dataset.tab ?? "null") as FileTab;
}

beforeEach(() => {
  editorMounts.count = 0;
  createFileApi.mockClear();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("FilePeek", () => {
  it("見出しにパスを出し、FileEditor へ合成したタブを渡す (revealSeq = seq)", () => {
    const { container } = setup();
    expect(container.textContent).toContain("PEEK");
    const path = container.querySelector('span[title="src/a.ts"]');
    expect(path?.textContent).toBe("src/a.ts");
    expect(shownTab(container)).toEqual({
      id: "peek:src/a.ts",
      kind: "file",
      filePath: "src/a.ts",
      targetLine: 10,
      revealSeq: 1,
    });
    expect(createFileApi).toHaveBeenCalledWith(socket, "s1");
  });

  it("見えているかを FileEditor へ伝える", () => {
    const { container, rerender } = setup({ isVisible: false });
    const editor = () =>
      container.querySelector<HTMLElement>('[data-testid="file-editor"]');
    expect(editor()?.dataset.visible).toBe("false");
    rerender({ isVisible: true });
    expect(editor()?.dataset.visible).toBe("true");
  });

  it("socket が無い間はエディタを出さない", () => {
    const { container } = setup({ socket: null });
    expect(container.querySelector('[data-testid="file-editor"]')).toBeNull();
    expect(container.textContent).toContain("接続中…");
  });

  it("未保存でなければ、閉じる・ファイルで開くは確認なしで呼び戻す", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { container, props } = setup();
    click(container, "ファイルで開く");
    expect(props.onPromote).toHaveBeenCalledWith(props.peek);
    click(container, "ピークを閉じる");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("未保存なら閉じる前に確認し、断れば閉じない", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, props } = setup();
    click(container, "dirty");

    click(container, "ピークを閉じる");
    expect(confirm).toHaveBeenCalledWith(
      "保存していない変更があります。閉じますか？"
    );
    expect(props.onClose).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    click(container, "ピークを閉じる");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("未保存ならファイルで開く前にも確認する", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, props } = setup();
    click(container, "dirty");

    click(container, "ファイルで開く");
    expect(props.onPromote).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    click(container, "ファイルで開く");
    expect(props.onPromote).toHaveBeenCalledWith(props.peek);
  });

  it("同じパスの開き直しは、エディタを作り直さず行だけ追従する", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { container, rerender } = setup();
    click(container, "dirty");
    rerender({ peek: peekOf("src/a.ts", 2, 40) });
    expect(shownTab(container)).toMatchObject({
      filePath: "src/a.ts",
      targetLine: 40,
      revealSeq: 2,
    });
    expect(editorMounts.count).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("別のパスへは、未保存でなければ確認なしで差し替える", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { container, rerender } = setup();
    rerender({ peek: peekOf("src/b.ts", 2) });
    expect(shownTab(container)).toMatchObject({
      id: "peek:src/b.ts",
      filePath: "src/b.ts",
      revealSeq: 2,
    });
    expect(editorMounts.count).toBe(2);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("未保存のまま別のパスへ差し替えるときは確認し、断れば今のファイルを残す", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, props, rerender } = setup();
    click(container, "dirty");

    const next = peekOf("src/b.ts", 2);
    rerender({ peek: next });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(shownTab(container).filePath).toBe("src/a.ts");
    expect(editorMounts.count).toBe(1);

    // 同じ依頼の再描画では聞き直さない
    rerender({ peek: next, isVisible: false });
    expect(confirm).toHaveBeenCalledTimes(1);

    // 断ったあとに「ファイルで開く」のは、見えているほう
    confirm.mockReturnValue(true);
    click(container, "ファイルで開く");
    expect(props.onPromote).toHaveBeenCalledWith(props.peek);

    // もう 1 度リンクを踏めば聞き直し、承諾すれば差し替える
    rerender({ peek: peekOf("src/b.ts", 3) });
    expect(shownTab(container).filePath).toBe("src/b.ts");
    expect(editorMounts.count).toBe(2);
  });

  it("同じパスを開き直した後に差し替えを断ると、最後に開いた行を残す", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, props, rerender } = setup();
    const latest = peekOf("src/a.ts", 2, 40);
    rerender({ peek: latest });
    click(container, "dirty");
    rerender({ peek: peekOf("src/b.ts", 3, 70) });
    expect(shownTab(container)).toMatchObject({
      filePath: "src/a.ts",
      targetLine: 40,
      revealSeq: 2,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    click(container, "ファイルで開く");
    expect(props.onPromote).toHaveBeenCalledWith(latest);
  });

  it("未保存の間だけ beforeunload を止める", () => {
    const { container } = setup();
    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    click(container, "dirty");
    expect(fire()).toBe(true);
    click(container, "clean");
    expect(fire()).toBe(false);
  });
});
