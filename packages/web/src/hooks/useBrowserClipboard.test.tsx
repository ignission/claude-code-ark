// @vitest-environment jsdom

import type { BrowserClientMessage } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserClipboard,
  COPY_REQUEST_TTL_MS,
  useBrowserClipboard,
} from "./useBrowserClipboard";

let root: Root;
let container: HTMLDivElement;
let api: BrowserClipboard;
let now = 1000;
const send = vi.fn<(msg: BrowserClientMessage) => void>();
const onFail = vi.fn();
const writeText = vi.fn<(text: string) => Promise<void>>();

function Harness() {
  api = useBrowserClipboard({ send, onFail });
  return null;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  now = 1000;
  send.mockReset();
  onFail.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBrowserClipboard", () => {
  it("`requestCopy` で `copy` を送り、届いた文字列を書く", async () => {
    api.requestCopy();
    expect(send.mock.calls).toEqual([[{ t: "copy" }]]);
    api.receive("選んだ文字列");
    await settle();

    expect(writeText.mock.calls).toEqual([["選んだ文字列"]]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("頼んでいない文字列は書かない", async () => {
    api.receive("頼んでいない");
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it("1回頼んで書くのは、最初の1通だけ", async () => {
    api.requestCopy();
    api.receive("1通目");
    api.receive("2通目");
    await settle();

    expect(writeText.mock.calls).toEqual([["1通目"]]);
  });

  it("頼んでから時間が過ぎて届いた文字列は書かない。その頼みは、使い終わったことにする", async () => {
    api.requestCopy();
    now += COPY_REQUEST_TTL_MS + 1;
    api.receive("遅れた返事");
    now -= COPY_REQUEST_TTL_MS;
    api.receive("そのあとの返事");
    await settle();
    expect(writeText).not.toHaveBeenCalled();

    api.requestCopy();
    now += COPY_REQUEST_TTL_MS;
    api.receive("間に合った返事");
    await settle();
    expect(writeText.mock.calls).toEqual([["間に合った返事"]]);
  });

  it("文字列でないものは書かない", async () => {
    api.requestCopy();
    api.receive(undefined);
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it("`reset` で、頼んだ分を忘れる", async () => {
    api.requestCopy();
    api.reset();
    api.receive("前の接続の返事");
    await settle();

    expect(writeText).not.toHaveBeenCalled();
  });

  it("書けなければ `onFail` を呼ぶ", async () => {
    writeText.mockRejectedValue(new Error("NotAllowedError"));
    api.requestCopy();
    api.receive("選んだ文字列");
    await settle();
    expect(onFail).toHaveBeenCalledTimes(1);

    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    api.requestCopy();
    api.receive("選んだ文字列");
    await settle();
    expect(onFail).toHaveBeenCalledTimes(2);

    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: () => {
          throw new Error("同期で投げる");
        },
      },
    });
    api.requestCopy();
    api.receive("選んだ文字列");
    await settle();
    expect(onFail).toHaveBeenCalledTimes(3);
  });
});
