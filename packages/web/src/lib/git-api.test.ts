import { describe, expect, it, vi } from "vitest";
import { createGitApi } from "./git-api";

type Handler = (...args: unknown[]) => void;

/** emit の ack を握れる偽 socket。ackMode が "silent" なら timeout エラーを返す */
function createFakeSocket(ackMode: "silent" | "reply" = "reply") {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    timeout: vi.fn(() => ({
      emit: (event: string, payload: unknown, cb: Handler) => {
        emitted.push({ event, payload });
        if (ackMode === "silent") cb(new Error("timeout"));
        else cb(null, { ok: true, echo: event });
      },
    })),
  };
  return { socket, emitted };
}

// biome-ignore lint/suspicious/noExplicitAny: 偽socketを渡すため
const asSocket = (s: unknown) => s as any;

describe("createGitApi", () => {
  it("各メソッドが正しいイベントと payload を emit する", async () => {
    const f = createFakeSocket();
    const api = createGitApi(asSocket(f.socket), "s1");
    await api.log(10, 50);
    await api.refs();
    await api.status();
    await api.commit("abc");
    await api.fileDiff({ kind: "commit", sha: "abc" }, "a.ts", "b.ts");
    await api.fileDiff({ kind: "staged" }, "a.ts");
    await api.fingerprint();
    expect(f.socket.timeout).toHaveBeenCalledWith(5000);
    expect(f.emitted).toEqual([
      { event: "git:log", payload: { sessionId: "s1", skip: 10, limit: 50 } },
      { event: "git:refs", payload: { sessionId: "s1" } },
      { event: "git:status", payload: { sessionId: "s1" } },
      { event: "git:commit", payload: { sessionId: "s1", sha: "abc" } },
      {
        event: "git:file-diff",
        payload: {
          sessionId: "s1",
          target: { kind: "commit", sha: "abc" },
          path: "a.ts",
          oldPath: "b.ts",
        },
      },
      {
        event: "git:file-diff",
        payload: {
          sessionId: "s1",
          target: { kind: "staged" },
          path: "a.ts",
          oldPath: undefined,
        },
      },
      { event: "git:fingerprint", payload: { sessionId: "s1" } },
    ]);
  });

  it("書き込みの操作は正しいイベントで emit し、リモートの操作だけ長く待つ", async () => {
    const f = createFakeSocket();
    const api = createGitApi(asSocket(f.socket), "s1");
    await api.createBranch("x", "abc1234");
    await api.renameBranch("x", "y");
    await api.deleteBranch("y", true);
    expect(f.socket.timeout).toHaveBeenLastCalledWith(5000);
    await api.deleteRemoteBranch("origin", "y");
    await api.fetch();
    await api.pull();
    await api.push("main");
    expect(f.socket.timeout).toHaveBeenLastCalledWith(130_000);
    expect(f.socket.timeout).toHaveBeenCalledTimes(7);
    expect(f.emitted).toEqual([
      {
        event: "git:branch-create",
        payload: { sessionId: "s1", name: "x", startPoint: "abc1234" },
      },
      {
        event: "git:branch-rename",
        payload: { sessionId: "s1", from: "x", to: "y" },
      },
      {
        event: "git:branch-delete",
        payload: { sessionId: "s1", name: "y", force: true },
      },
      {
        event: "git:remote-branch-delete",
        payload: { sessionId: "s1", remote: "origin", name: "y" },
      },
      { event: "git:fetch", payload: { sessionId: "s1" } },
      { event: "git:pull", payload: { sessionId: "s1" } },
      { event: "git:push", payload: { sessionId: "s1", name: "main" } },
    ]);
  });

  it("ack の応答をそのまま返す", async () => {
    const f = createFakeSocket();
    const api = createGitApi(asSocket(f.socket), "s1");
    expect(await api.refs()).toEqual({ ok: true, echo: "git:refs" });
  });

  it("ack が返らないときはすべて ok: false に畳む", async () => {
    const f = createFakeSocket("silent");
    const api = createGitApi(asSocket(f.socket), "s1");
    const results = await Promise.all([
      api.log(0, 10),
      api.refs(),
      api.status(),
      api.commit("abc"),
      api.fileDiff({ kind: "unstaged" }, "a.ts"),
      api.fingerprint(),
    ]);
    for (const r of results) {
      expect(r).toEqual({ ok: false, error: "サーバーから応答がありません" });
    }
  });
});
