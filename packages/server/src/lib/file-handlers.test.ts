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
    const tmpDir = fs.mkdtempSync("/tmp/ark-fh-");
    try {
      fs.writeFileSync(path.join(tmpDir, "t.txt"), "tmp!");
      const cb = vi.fn();
      await make().open(
        { sessionId: "s1", filePath: path.join(tmpDir, "t.txt") },
        cb
      );
      expect(cb.mock.calls[0][0].ok).toBe(true);
      expect(cb.mock.calls[0][0].content).toBe("tmp!");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/tmp/.. を含むパスは拒否する", async () => {
    const cb = vi.fn();
    await make().open({ sessionId: "s1", filePath: "/tmp/../etc/passwd" }, cb);
    expect(cb.mock.calls[0][0].ok).toBe(false);
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

  it("dispose 後に解決した subscribe は監視を張らない", async () => {
    const h = make();
    const pending = h.subscribe(p("a.txt"));
    h.dispose();
    await pending;
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("未知のセッションや拒否されたパスでは張らず throw しない", async () => {
    const h = make();
    await expect(
      h.subscribe({ sessionId: "x", filePath: "a.txt" })
    ).resolves.toBeUndefined();
    await expect(h.subscribe(p("../../etc/passwd"))).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("/tmp/.. を含むパスは購読しない", async () => {
    await make().subscribe(p("/tmp/../etc/passwd"));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("/tmp の symlink で外のファイルを指すものは購読しない", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/ark-fh-");
    try {
      // /tmp の外 (/var/tmp) に実体を作る
      const outside = fs.mkdtempSync("/var/tmp/ark-fh-");
      try {
        const target = path.join(outside, "secret.txt");
        fs.writeFileSync(target, "x");
        const link2 = path.join(tmpDir, "link2");
        fs.symlinkSync(target, link2);
        await make().subscribe(p(link2));
        expect(subscribe).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("解決待ちの間に来た unsubscribe で購読が残らない", async () => {
    const h = make();
    const pending = h.subscribe(p("a.txt"));
    h.unsubscribe(p("a.txt"));
    await pending;
    // 張られても直ちに解除される
    for (const un of unsubs) expect(un).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls.length).toBe(unsubs.length);
    // 以後の unsubscribe/dispose で二重解除されない
    h.dispose();
    for (const un of unsubs) expect(un).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe の後に同じ鍵を再購読できる", async () => {
    const h = make();
    const first = h.subscribe(p("a.txt"));
    h.unsubscribe(p("a.txt"));
    await first;
    await h.subscribe(p("a.txt"));
    const live = unsubs.filter(un => un.mock.calls.length === 0);
    expect(live).toHaveLength(1);
  });

  it("購読・解除・再購読を待たずに続けても、最後の購読が残る", async () => {
    const h = make();
    const first = h.subscribe(p("a.txt"));
    h.unsubscribe(p("a.txt"));
    const second = h.subscribe(p("a.txt"));
    await Promise.all([first, second]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const live = unsubs.filter(un => un.mock.calls.length === 0);
    expect(live).toHaveLength(1);
  });
});
