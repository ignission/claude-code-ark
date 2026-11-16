import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSketchDraft,
  readDiagramSketchMessage,
  sketchLabels,
  uploadSketch,
} from "./board-sketch";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("readDiagramSketchMessage", () => {
  it("PNG の data URL から base64 の部分を取り出す", () => {
    expect(
      readDiagramSketchMessage({ type: "ark:diagram-sketch", dataUrl: PNG })
    ).toEqual({ kind: "picture", base64: "iVBORw0KGgo=" });
  });

  it("層が知らせた失敗と、PNG でないものは失敗として扱う", () => {
    for (const data of [
      { type: "ark:diagram-sketch-error" },
      { type: "ark:diagram-sketch" },
      { type: "ark:diagram-sketch", dataUrl: "data:image/svg+xml,<svg/>" },
      { type: "ark:diagram-sketch", dataUrl: "data:image/png;base64," },
      { type: "ark:diagram-sketch", dataUrl: "data:image/png;base64,@@@" },
      { type: "ark:diagram-sketch", dataUrl: "https://example.com/a.png" },
    ]) {
      expect(readDiagramSketchMessage(data)).toEqual({ kind: "error" });
    }
  });

  it("別の種類のメッセージは読まない", () => {
    expect(readDiagramSketchMessage(null)).toBeNull();
    expect(readDiagramSketchMessage({ type: "ark:diagram-scroll" })).toBeNull();
  });
});

describe("入力欄に入れる文と、層へ渡す文言", () => {
  it("画像を @パス で指し、どの図への書き込みかを添える", () => {
    expect(
      buildSketchDraft(
        "/tmp/ark-files/s1/a.png",
        ".claude/diagrams/x.diagram.html"
      )
    ).toBe(
      "@/tmp/ark-files/s1/a.png ボード `.claude/diagrams/x.diagram.html` に手書きで書き込みました。画像の赤い線が書き込みです。"
    );
  });

  it("層のボタンの文言を渡す", () => {
    expect(sketchLabels()).toEqual({
      draw: "描く",
      undo: "戻す",
      clear: "消す",
      send: "Claudeに見せる",
      sending: "画像にしています...",
      close: "終わる",
    });
  });
});

describe("uploadSketch", () => {
  type Handler = (data: Record<string, unknown>) => void;
  function fakeSocket() {
    const handlers = new Map<string, Set<Handler>>();
    const emitted: Array<Record<string, unknown>> = [];
    return {
      emitted,
      count: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
      fire: (event: string, data: Record<string, unknown>) => {
        for (const handler of handlers.get(event) ?? []) handler(data);
      },
      socket: {
        on: (event: string, handler: Handler) => {
          if (!handlers.has(event)) handlers.set(event, new Set());
          handlers.get(event)?.add(handler);
        },
        off: (event: string, handler: Handler) => {
          handlers.get(event)?.delete(handler);
        },
        emit: (_event: string, data: Record<string, unknown>) => {
          emitted.push(data);
        },
      },
    };
  }
  type SocketArg = Parameters<typeof uploadSketch>[0];

  afterEach(() => vi.useRealTimers());

  it("会話の添付と同じイベントで送り、自分の要求への応答だけでパスを返す", async () => {
    const io = fakeSocket();
    const pending = uploadSketch(
      io.socket as unknown as SocketArg,
      "s1",
      "AAAA"
    );
    expect(io.emitted[0]).toMatchObject({
      sessionId: "s1",
      base64Data: "AAAA",
      mimeType: "image/png",
    });
    io.fire("file-upload:uploaded", { requestId: "他の要求", path: "/x" });
    io.fire("file-upload:uploaded", {
      requestId: io.emitted[0].requestId,
      path: "/tmp/ark-files/s1/a.png",
    });
    await expect(pending).resolves.toBe("/tmp/ark-files/s1/a.png");
    expect(io.count()).toBe(0);
  });

  it("サーバーが断ったら理由つきで失敗する", async () => {
    const io = fakeSocket();
    const pending = uploadSketch(
      io.socket as unknown as SocketArg,
      "s1",
      "AAAA"
    );
    io.fire("file-upload:error", {
      requestId: io.emitted[0].requestId,
      message: "大きすぎます",
    });
    await expect(pending).rejects.toThrow("大きすぎます");
    expect(io.count()).toBe(0);
  });

  it("応答が無ければ時間切れで失敗し、受け口を外す", async () => {
    vi.useFakeTimers();
    const io = fakeSocket();
    const pending = uploadSketch(
      io.socket as unknown as SocketArg,
      "s1",
      "AAAA"
    );
    const settled = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    expect(io.count()).toBe(0);
  });
});
