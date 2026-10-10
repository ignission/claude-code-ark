// @vitest-environment jsdom

import type { FileIndexResponse, ManagedSession, Worktree } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PALETTE_CLOSED_EVENT,
  PALETTE_OPEN_EVENT,
  type PaletteClosedDetail,
} from "@/lib/palette";
import { CommandPalette, type CommandPaletteProps } from "./CommandPalette";

const worktrees = [
  { id: "w1", path: "/repo/ark", branch: "main", isMain: true },
  { id: "w2", path: "/repo/haus", branch: "feat/login", isMain: true },
  { id: "w3", path: "/repo/idle", branch: "main", isMain: true },
] as unknown as Worktree[];
const sessions = new Map<string, ManagedSession>(
  [
    { id: "s1", worktreeId: "w1", worktreePath: "/repo/ark" },
    { id: "s2", worktreeId: "w2", worktreePath: "/repo/haus" },
  ].map(s => [s.id, s as unknown as ManagedSession])
);

let container: HTMLDivElement;
let root: Root;
let closed: PaletteClosedDetail[];
const onClosed = (event: Event) =>
  closed.push((event as CustomEvent<PaletteClosedDetail>).detail);

function setup(overrides: Partial<CommandPaletteProps> = {}) {
  const props: CommandPaletteProps = {
    sessions,
    worktrees,
    repoList: ["/repo/ark", "/repo/haus", "/repo/idle"],
    sessionStatuses: new Map(),
    worktreeDisplayNames: new Map(),
    selectedSessionId: "s1",
    listDiagrams: vi.fn(async () => [
      {
        relPath: ".claude/diagrams/flow.diagram.html",
        displayName: "ログインの流れ",
        tracked: false,
      },
    ]),
    fetchFileIndex: vi.fn(
      async (): Promise<FileIndexResponse> => ({
        ok: true,
        paths: ["src/keynav.ts", "src/keynav.test.ts", "README.md"],
        truncated: false,
      })
    ),
    onSelectSession: vi.fn(),
    onOpenDiagram: vi.fn(),
    onOpenFile: vi.fn(),
    onAsk: vi.fn(),
    onOpenBoardSuggestSettings: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<CommandPalette {...props} />));
  return props;
}

async function open() {
  await act(async () => {
    window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
  });
  // 図とファイルの一覧が届くのを待つ
  await act(async () => {});
}
const input = () =>
  document.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    el => el.firstElementChild?.textContent
  );
const selected = () =>
  document.querySelector('[role="option"][aria-selected="true"]')
    ?.firstElementChild?.textContent;

async function type(text: string) {
  const el = input();
  if (!el) throw new Error("no input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    input()?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  closed = [];
  window.addEventListener(PALETTE_CLOSED_EVENT, onClosed);
});
afterEach(() => {
  window.removeEventListener(PALETTE_CLOSED_EVENT, onClosed);
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("CommandPalette", () => {
  it("合図が来るまでは何も出さず、来たら入力欄にフォーカスを置く", async () => {
    setup();
    expect(input()).toBeNull();
    await open();
    expect(document.activeElement).toBe(input());
    // 入力モードへ戻す合図にならないよう、印を持つ
    expect(input()?.closest("[data-keynav-ignore]")).not.toBeNull();
  });

  it("何も打っていなければ、起動中のセッションとコマンドを出す", async () => {
    setup();
    await open();
    const got = options();
    expect(got.slice(0, 2)).toEqual(["ark", "haus"]);
    // 起動していない worktree は載せない
    expect(got).not.toContain("idle");
    expect(got).toContain("Git のタブを開く");
  });

  it("セッションを選ぶと、そのセッションを開いて閉じる", async () => {
    const props = setup();
    await open();
    await type("haus");
    expect(selected()).toBe("haus");
    await press("Enter");
    expect(props.onSelectSession).toHaveBeenCalledWith("s2");
    expect(input()).toBeNull();
    expect(closed).toHaveLength(1);
  });

  it("ファイルは開いた時点のセッションで開き、閉じたあとは作業エリアにいる", async () => {
    const props = setup();
    await open();
    await type("keynav");
    expect(options().slice(0, 2)).toEqual(["keynav.ts", "keynav.test.ts"]);
    await press("ArrowDown");
    await press("Enter");
    expect(props.onOpenFile).toHaveBeenCalledWith("s1", "src/keynav.test.ts");
    expect(closed[0]).toMatchObject({ region: "work" });
  });

  it("図は開いた時点のセッションの worktree で開く", async () => {
    const props = setup();
    await open();
    // 開いている間に選択が替わっても (通知から別のセッションを開いた、など)
    act(() =>
      root.render(<CommandPalette {...props} selectedSessionId="s2" />)
    );
    await type("ログイン");
    await press("Enter");
    expect(props.onOpenDiagram).toHaveBeenCalledWith(
      "s1",
      "/repo/ark",
      ".claude/diagrams/flow.diagram.html"
    );
  });

  it("場所やタブを替えるコマンドは、自分で実行せず KeyNavLayer へ返す", async () => {
    setup();
    await open();
    await type("git");
    await press("Enter");
    expect(closed[0].command).toEqual({ type: "work-tab", tab: "git" });
  });

  it("ボード提案の設定は、フォーカスをそのダイアログに任せる", async () => {
    const props = setup();
    await open();
    await type("ボード提案");
    await press("Enter");
    expect(props.onOpenBoardSuggestSettings).toHaveBeenCalled();
    expect(closed[0].handoff).toBe(true);
  });

  it("Tab は打った文を、開いた時点のセッションの Claude へ送る", async () => {
    const props = setup();
    await open();
    await type("  このテストはなぜ落ちる?  ");
    await press("Tab");
    expect(props.onAsk).toHaveBeenCalledWith("s1", "このテストはなぜ落ちる?");
    expect(closed[0]).toMatchObject({ region: "left" });
  });

  it("何も一致しなければ、Enter は「Claude に聞く」になる", async () => {
    const props = setup();
    await open();
    await type("zzzz qqqq");
    expect(options()).toEqual(["Claude に聞く: zzzz qqqq"]);
    await press("Enter");
    expect(props.onAsk).toHaveBeenCalledWith("s1", "zzzz qqqq");
  });

  it("何も打っていなければ、Tab では何も送らない", async () => {
    const props = setup();
    await open();
    await press("Tab");
    expect(props.onAsk).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it("変換の確定の Enter では実行しない", async () => {
    const props = setup();
    await open();
    await type("haus");
    await press("Enter", { isComposing: true });
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it("Esc は何もせずに閉じ、上下は端で反対側へ回る", async () => {
    const props = setup();
    await open();
    await press("ArrowUp");
    expect(selected()).toBe(options().at(-1));
    await press("n", { ctrlKey: true });
    expect(selected()).toBe("ark");
    await press("Escape");
    expect(input()).toBeNull();
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(closed).toEqual([{}]);
  });

  it("セッションを選んでいなければ、「聞く」の行を出さない", async () => {
    setup({ selectedSessionId: null });
    await open();
    await type("なにか");
    expect(options()).toEqual([]);
  });

  it("ファイルの一覧を取れなければ、その旨を出してほかの候補は使える", async () => {
    setup({
      fetchFileIndex: vi.fn(
        async (): Promise<FileIndexResponse> => ({
          ok: false,
          error: "git が失敗しました",
        })
      ),
    });
    await open();
    expect(document.body.textContent).toContain("git が失敗しました");
    await type("haus");
    expect(selected()).toBe("haus");
  });
});
