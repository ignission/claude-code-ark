// @vitest-environment jsdom

import type { DiagramNotesResponse } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeChatSends } from "@/lib/chat-draft-store";
import { DiagramPane, type DiagramPaneProps } from "./DiagramPane";

const WT = "/wt";
const REL = ".claude/diagrams/plan.diagram.html";
const NOTES = {
  notes: [{ id: "n1", author: "human" as const, text: "やること", x: 0, y: 0 }],
  frames: [],
};

type Handler = (...args: unknown[]) => void;

/** emit を記録し、ACK と、サーバーからの通知を手で起こせるソケット */
function fakeSocket() {
  const emitted: Array<{ event: string; data: unknown; ack?: Handler }> = [];
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    emit: (event: string, data: unknown, ack?: Handler) => {
      emitted.push({ event, data, ack });
    },
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
  };
  const fire = (event: string, data: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(data);
  };
  const last = (event: string) => emitted.filter(e => e.event === event).at(-1);
  return { socket, emitted, fire, last };
}

const channels: MessageChannel[] = [];
const RealMessageChannel = globalThis.MessageChannel;

let container: HTMLDivElement;
let root: Root;
let io: ReturnType<typeof fakeSocket>;
let onSelectDiagram: ReturnType<typeof vi.fn>;

function render(overrides: Partial<DiagramPaneProps> = {}) {
  const props: DiagramPaneProps = {
    sessionId: "s1",
    worktreePath: WT,
    relPath: REL,
    isConnected: true,
    listDiagrams: async () => [
      { relPath: REL, displayName: "計画", tracked: false },
    ],
    deleteDiagram: vi.fn(),
    onSelectDiagram,
    socket: io.socket as unknown as DiagramPaneProps["socket"],
    ...overrides,
  };
  return act(async () => {
    root.render(<DiagramPane {...props} />);
  });
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    item => item.textContent?.trim() === label
  ) as HTMLButtonElement | undefined;
const notice = () =>
  document.querySelector("[data-board-notice]")?.textContent ?? null;
const answerNotes = (response: DiagramNotesResponse) =>
  act(async () => {
    io.last("diagram:notes:get")?.ack?.(response);
  });

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      text: async () => "<!doctype html><html><body>図</body></html>",
    }))
  );
  channels.length = 0;
  vi.stubGlobal(
    "MessageChannel",
    class extends RealMessageChannel {
      constructor() {
        super();
        channels.push(this);
      }
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  io = fakeSocket();
  onSelectDiagram = vi.fn();
  takeChatSends(WT);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ボードの付箋", () => {
  it("図を開くと付箋を読み、付箋のファイルが変わったら読み直す", async () => {
    await render();
    expect(io.last("diagram:notes:get")?.data).toEqual({
      worktreePath: WT,
      relPath: REL,
    });
    const before = io.emitted.filter(e => e.event === "diagram:notes:get");
    await act(async () => {
      io.fire("diagram:notes:updated", { worktreePath: WT, relPath: REL });
      io.fire("diagram:notes:updated", { worktreePath: WT, relPath: "他の図" });
    });
    expect(
      io.emitted.filter(e => e.event === "diagram:notes:get")
    ).toHaveLength(before.length + 1);
  });

  it("付箋が無いうちは渡せず、付箋があれば渡せる", async () => {
    await render();
    await answerNotes({
      ok: true,
      notes: { notes: [], frames: [] },
      dropped: 0,
    });
    expect(button("Claudeに渡す")?.disabled).toBe(true);
    expect(button("Claudeに渡す")?.title).toBe("付箋を置くと渡せます");
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    expect(button("Claudeに渡す")?.disabled).toBe(false);
  });

  it("Claude が作業中や確認待ちの間は渡せない", async () => {
    await render({ bridgeStatus: "AWAITING" });
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    expect(button("Claudeに渡す")?.disabled).toBe(true);
    expect(button("Claudeに渡す")?.title).toBe(
      "Claudeの作業が終わると渡せます"
    );
  });

  it("渡すと定型文を1通だけ送りに出し、Claude の番が終わるまで知らせを出す", async () => {
    await render({ bridgeStatus: "IDLE" });
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    await act(async () => button("Claudeに渡す")?.click());

    const sends = takeChatSends(WT);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("`.claude/diagrams/plan.notes.json`");
    expect(notice()).toBe("Claudeの番です。終わるとボードが書き換わります");
    // 番の間は、続けて押せない
    expect(button("Claudeに渡す")?.disabled).toBe(true);

    await render({ bridgeStatus: "TOOL" });
    await render({ bridgeStatus: "AWAITING" });
    expect(notice()).toBe("Claudeが確認を待っています。会話を見てください");
    await render({ bridgeStatus: "IDLE" });
    expect(notice()).toBeNull();
    expect(button("Claudeに渡す")?.disabled).toBe(false);
  });

  it("渡したのに Claude が動き出さなければ、しばらくして表示を戻す", async () => {
    vi.useFakeTimers();
    await render({ bridgeStatus: "IDLE" });
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    await act(async () => button("Claudeに渡す")?.click());
    expect(notice()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(notice()).toBeNull();
  });

  it("付箋のファイルが読めなくても、最後に読めた付箋を保ち、知らせを出す", async () => {
    await render();
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    await answerNotes({ ok: false, code: "invalid" });
    expect(notice()).toContain("付箋のファイルを読めません");
    // 付箋は残っているので、渡すボタンは押せるまま
    expect(button("Claudeに渡す")?.disabled).toBe(false);
  });

  it("読み飛ばした付箋があれば、その数を知らせる", async () => {
    await render();
    await answerNotes({ ok: true, notes: NOTES, dropped: 2 });
    expect(notice()).toBe("形の合わない付箋や枠を2件読み飛ばしました");
  });
});

describe("図の中の層とのやり取り", () => {
  /**
   * 図の中の層が受け取るはずの port を横取りする。jsdom は srcDoc の iframe を自分でロード
   * するので、そのとき DiagramPane が作った MessageChannel の相手側を使う
   */
  async function connectLayer() {
    const settle = () =>
      act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
    await settle();
    const port = channels.at(-1)?.port2;
    if (!port) throw new Error("DiagramPane が port を作っていない");
    const received: unknown[] = [];
    port.onmessage = event => received.push(event.data);
    return { port, received, settle };
  }

  it("読めた付箋を層へ渡す。図が読み直されたあとの層にも渡し直す", async () => {
    await render();
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    const first = await connectLayer();
    await first.settle();
    expect(first.received).toContainEqual({
      type: "ark:diagram-notes",
      ...NOTES,
    });

    const moved = {
      notes: [{ ...NOTES.notes[0], x: 200 }],
      frames: [{ id: "f1", label: "枠", x: 0, y: 0, w: 400, h: 200 }],
    };
    await answerNotes({ ok: true, notes: moved, dropped: 0 });
    await first.settle();
    expect(first.received.at(-1)).toEqual({
      type: "ark:diagram-notes",
      ...moved,
    });
    first.port.close();
  });

  it("層から届いた付箋の操作を保存し、返ってきた付箋を画面に反映する", async () => {
    await render();
    await answerNotes({
      ok: true,
      notes: { notes: [], frames: [] },
      dropped: 0,
    });
    expect(button("Claudeに渡す")?.disabled).toBe(true);
    const layer = await connectLayer();
    layer.port.postMessage({
      type: "ark:diagram-note-op",
      op: { type: "add", id: "n1", x: 10, y: 20 },
      viewWidth: 900,
    });
    await layer.settle();
    const request = io.last("diagram:notes:op");
    expect(request?.data).toEqual({
      worktreePath: WT,
      relPath: REL,
      op: { type: "add", id: "n1", x: 10, y: 20 },
      viewWidth: 900,
    });
    await act(async () => {
      request?.ack?.({ ok: true, notes: NOTES, dropped: 0 });
    });
    expect(button("Claudeに渡す")?.disabled).toBe(false);
    layer.port.close();
  });

  it("層からは Claude への送信を起こせない", async () => {
    await render();
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    const layer = await connectLayer();
    layer.port.postMessage({ type: "ark:diagram-hand-off" });
    layer.port.postMessage({
      type: "ark:diagram-note-op",
      op: { type: "send", id: "n1" },
    });
    await layer.settle();
    expect(takeChatSends(WT)).toEqual([]);
    expect(io.last("diagram:notes:op")).toBeUndefined();
    layer.port.close();
  });

  it("付箋を足すボタンは、層に足す場所を決めさせる", async () => {
    await render();
    await answerNotes({ ok: true, notes: NOTES, dropped: 0 });
    const layer = await connectLayer();
    await act(async () => button("付箋を足す")?.click());
    await layer.settle();
    expect(layer.received).toContainEqual({ type: "ark:diagram-note-add" });
    layer.port.close();
  });
});

describe("新しいボード", () => {
  it("図の一覧から白紙のボードを作り、そのまま開く", async () => {
    await render({ relPath: undefined });
    await act(async () => button("新しいボード")?.click());
    const request = io.last("diagram:create");
    expect(request?.data).toMatchObject({ worktreePath: WT });
    expect(request?.data).toMatchObject({
      title: expect.stringMatching(/^ホワイトボード \d+\/\d+ \d\d:\d\d$/),
    });
    const created = ".claude/diagrams/board-20261114-090507.diagram.html";
    await act(async () => {
      request?.ack?.({ ok: true, relPath: created });
    });
    expect(onSelectDiagram).toHaveBeenCalledWith(created, WT);
  });

  it("作れなかったら、理由を出す", async () => {
    await render({ relPath: undefined });
    await act(async () => button("新しいボード")?.click());
    await act(async () => {
      io.last("diagram:create")?.ack?.({ ok: false, error: "EACCES" });
    });
    expect(document.body.textContent).toContain(
      "ボードを作れませんでした: EACCES"
    );
    expect(onSelectDiagram).not.toHaveBeenCalled();
  });
});
