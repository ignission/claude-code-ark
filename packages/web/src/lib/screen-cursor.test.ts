// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { keepLocalCursorUntilServerCursor } from "./screen-cursor";

// MutationObserver は非同期 (microtask) に届くので 1 tick 待つ
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("keepLocalCursorUntilServerCursor", () => {
  it("noVNC が cursor を none にしたら、ブラウザの矢印 (default) に戻す", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.cursor = "none";
    const stop = keepLocalCursorUntilServerCursor(canvas, {
      usesFallback: false,
    });
    expect(canvas.style.cursor).toBe("default");

    canvas.style.cursor = "none";
    await tick();
    expect(canvas.style.cursor).toBe("default");
    stop();
  });

  it("サーバーのカーソル (url) が届いたら以後は noVNC に任せる", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.cursor = "none";
    const stop = keepLocalCursorUntilServerCursor(canvas, {
      usesFallback: false,
    });

    canvas.style.cursor = "url(data:image/png;base64,AAAA) 1 2, default";
    await tick();
    expect(canvas.style.cursor).toContain("url(");

    canvas.style.cursor = "none";
    await tick();
    expect(canvas.style.cursor).toBe("none");
    stop();
  });

  it("同じタスクで url の後に none になってもサーバーカーソルと判定する", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.cursor = "none";
    const stop = keepLocalCursorUntilServerCursor(canvas, {
      usesFallback: false,
    });

    canvas.style.cursor = "url(data:image/png;base64,AAAA) 1 2, default";
    canvas.style.cursor = "none";
    await tick();
    expect(canvas.style.cursor).toBe("none");
    stop();
  });

  it("noVNC が別 canvas にカーソルを描く経路では何もしない", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.cursor = "none";
    const stop = keepLocalCursorUntilServerCursor(canvas, {
      usesFallback: true,
    });
    expect(canvas.style.cursor).toBe("none");
    canvas.style.cursor = "none";
    await tick();
    expect(canvas.style.cursor).toBe("none");
    stop();
  });

  it("止めた後は触らない", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.cursor = "none";
    const stop = keepLocalCursorUntilServerCursor(canvas, {
      usesFallback: false,
    });
    stop();
    canvas.style.cursor = "none";
    await tick();
    expect(canvas.style.cursor).toBe("none");
  });
});
