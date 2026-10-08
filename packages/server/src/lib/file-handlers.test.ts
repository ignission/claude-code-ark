import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileHandlers } from "./file-handlers.js";

let dir: string;
let unsubs: ReturnType<typeof vi.fn>[];
let listeners: Map<string, () => void>;
const subscribe = vi.fn((abs: string, l: () => void) => {
  listeners.set(abs, l);
  const un = vi.fn();
  unsubs.push(un);
  return un;
});
const emitUpdated = vi.fn();

function make() {
  return createFileHandlers({
    getWorktreePath: id => (id === "s1" ? dir : undefined),
    watcher: { subscribe },
    emitUpdated,
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-fh-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  unsubs = [];
  listeners = new Map();
  subscribe.mockClear();
  emitUpdated.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("open", () => {
  it("内容と mtimeMs を返す", async () => {
    const cb = vi.fn();
    await make().open({ sessionId: "s1", filePath: "a.txt" }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    const r = cb.mock.calls[0][0];
    expect(r.ok).toBe(true);
    expect(r.content).toBe("hello");
    expect(typeof r.mtimeMs).toBe("number");
    expect(r.editable).toBe(true);
  });

  it("未知のセッションは ok:false", async () => {
    const cb = vi.fn();
    await make().open({ sessionId: "nope", filePath: "a.txt" }, cb);
    expect(cb.mock.calls[0][0].ok).toBe(false);
  });

  it("/tmp のファイルはセッションの存在だけ確かめて読む", async () => {
    const f = path.join(dir, "x");
    fs.writeFileSync(f, "t");
    const tmpFile = path.join(os.tmpdir(), `ark-fh-tmp-${process.pid}.txt`);
    fs.writeFileSync(tmpFile, "tmp!");
    try {
      const cb = vi.fn();
      await make().open({ sessionId: "s1", filePath: tmpFile }, cb);
      if (tmpFile.startsWith("/tmp/")) {
        expect(cb.mock.calls[0][0].ok).toBe(true);
        expect(cb.mock.calls[0][0].content).toBe("tmp!");
      }
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

describe("write", () => {
  it("成功すると新しい mtimeMs を返す", async () => {
    const h = make();
    const cb = vi.fn();
    await h.open({ sessionId: "s1", filePath: "a.txt" }, cb);
    const { mtimeMs } = cb.mock.calls[0][0];
    const wcb = vi.fn();
    await h.write(
      {
        sessionId: "s1",
        filePath: "a.txt",
        content: "new",
        expectedMtimeMs: mtimeMs,
      },
      wcb
    );
    expect(wcb.mock.calls[0][0].ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("new");
  });

  it("mtime が違うと conflict", async () => {
    const wcb = vi.fn();
    await make().write(
      {
        sessionId: "s1",
        filePath: "a.txt",
        content: "new",
        expectedMtimeMs: 1,
      },
      wcb
    );
    expect(wcb.mock.calls[0][0]).toMatchObject({ ok: false, code: "conflict" });
  });

  it("未知のセッションは code:error", async () => {
    const wcb = vi.fn();
    await make().write(
      { sessionId: "x", filePath: "a.txt", content: "n", expectedMtimeMs: 1 },
      wcb
    );
    expect(wcb.mock.calls[0][0]).toMatchObject({ ok: false, code: "error" });
  });
});

describe("list", () => {
  it("entries を返す", async () => {
    const cb = vi.fn();
    await make().list({ sessionId: "s1", dirPath: "." }, cb);
    const r = cb.mock.calls[0][0];
    expect(r.ok).toBe(true);
    expect(r.entries.map((e: { name: string }) => e.name)).toContain("a.txt");
    expect(r.truncated).toBe(false);
  });
});

describe("不正な payload", () => {
  it("throw せず、cb が無ければ何も起きない", async () => {
    const h = make();
    const cb = vi.fn();
    for (const bad of [
      null,
      undefined,
      1,
      "x",
      {},
      { sessionId: "s1", filePath: 1 },
    ]) {
      await expect(h.open(bad, cb)).resolves.toBeUndefined();
      await expect(h.list(bad, cb)).resolves.toBeUndefined();
      await expect(h.write(bad, cb)).resolves.toBeUndefined();
      await expect(h.subscribe(bad)).resolves.toBeUndefined();
      expect(() => h.unsubscribe(bad)).not.toThrow();
    }
    await expect(
      h.open({ sessionId: "s1", filePath: "a.txt" }, undefined)
    ).resolves.toBeUndefined();
    await expect(
      h.write(
        {
          sessionId: "s1",
          filePath: "a.txt",
          content: "z",
          expectedMtimeMs: 0,
        },
        "no"
      )
    ).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("hello");
  });
});

describe("subscribe", () => {
  const p = (filePath: string) => ({ sessionId: "s1", filePath });

  it("同じ鍵は 1 回だけ張る", async () => {
    const h = make();
    await h.subscribe(p("a.txt"));
    await h.subscribe(p("a.txt"));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("listener が emitUpdated を呼ぶ", async () => {
    await make().subscribe(p("a.txt"));
    listeners.get(path.join(dir, "a.txt"))?.();
    expect(emitUpdated).toHaveBeenCalledWith({
      sessionId: "s1",
      filePath: "a.txt",
    });
  });

  it("51 件目は張られない", async () => {
    const h = make();
    for (let i = 0; i < 51; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
      await h.subscribe(p(`f${i}.txt`));
    }
    expect(subscribe).toHaveBeenCalledTimes(50);
  });

  it("unsubscribe と dispose で解除される", async () => {
    const h = make();
    await h.subscribe(p("a.txt"));
    fs.writeFileSync(path.join(dir, "b.txt"), "x");
    await h.subscribe(p("b.txt"));
    h.unsubscribe(p("a.txt"));
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    h.dispose();
    expect(unsubs[1]).toHaveBeenCalledTimes(1);
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
  });

  it("dispose 後に解決した subscribe は直ちに解除する", async () => {
    const h = make();
    const pending = h.subscribe(p("a.txt"));
    h.dispose();
    await pending;
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
  });

  it("未知のセッションや拒否されたパスでは張らず throw しない", async () => {
    const h = make();
    await expect(
      h.subscribe({ sessionId: "x", filePath: "a.txt" })
    ).resolves.toBeUndefined();
    await expect(h.subscribe(p("../../etc/passwd"))).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
