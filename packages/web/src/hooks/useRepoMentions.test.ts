import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRepoMentionCandidates,
  REPO_MENTION_FRESH_MS,
  REPO_MENTION_TIMEOUT_MS,
} from "./useRepoMentions";

type Reply = (response: { repos?: string[]; error?: string }) => void;
type LoadSocket = Parameters<typeof loadRepoMentionCandidates>[0];

/** 応答を手で返せる socket の偽物。emit のたびに ack を溜める */
function createSocket() {
  const replies: Reply[] = [];
  const socket = {
    emit: vi.fn((_event: string, reply: Reply) => {
      replies.push(reply);
    }),
  };
  return {
    socket: socket as unknown as LoadSocket,
    emit: socket.emit,
    replies,
  };
}

const REPO = "/home/u/dev/github.com/acme/app";

describe("loadRepoMentionCandidates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("取れた結果を使い回し、古くなるまでサーバーに聞き直さない", async () => {
    const { socket, emit, replies } = createSocket();
    const first = loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    replies[0]({ repos: [REPO] });
    expect((await first).map(c => c.path)).toEqual([REPO]);

    await loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    expect(emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REPO_MENTION_FRESH_MS);
    void loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("応答を待っている間は、重ねて聞かない", () => {
    const { socket, emit } = createSocket();
    void loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    void loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("応答が来なければ待つのをやめ、次の呼び出しで聞き直す", async () => {
    const { socket, emit, replies } = createSocket();
    const lost = loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    vi.advanceTimersByTime(REPO_MENTION_TIMEOUT_MS);
    expect(await lost).toEqual([]);

    const retry = loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    expect(emit).toHaveBeenCalledTimes(2);
    replies[1]({ repos: [REPO] });
    expect((await retry).map(c => c.path)).toEqual([REPO]);
  });

  it("エラーのときは前の結果を残す", async () => {
    const { socket, replies } = createSocket();
    const first = loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    replies[0]({ repos: [REPO] });
    await first;

    vi.advanceTimersByTime(REPO_MENTION_FRESH_MS);
    const second = loadRepoMentionCandidates(socket, REPO_MENTION_FRESH_MS);
    replies[1]({ error: "scan failed" });
    expect((await second).map(c => c.path)).toEqual([REPO]);
  });
});
