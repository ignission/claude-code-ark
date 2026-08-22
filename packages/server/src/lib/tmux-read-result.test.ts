/**
 * tmux 読み取り結果の失敗分類 (#393)
 *
 * describeTmuxReadFailure が失敗要因ごとに原因を特定できる 1 行を返すこと、
 * TmuxReadFailureReporter が polling 経路で同じ失敗を毎 tick 出力しないことを検証する。
 */

import { describe, expect, it, vi } from "vitest";
import {
  describeTmuxReadFailure,
  type TmuxReadFailure,
  TmuxReadFailureReporter,
  type TmuxReadResult,
} from "./tmux-read-result.js";

const tmuxFailed = (over: Partial<TmuxReadFailure> = {}): TmuxReadFailure => ({
  kind: "tmux-failed",
  command: "capture-pane",
  status: 1,
  signal: null,
  stderr: "can't find pane: ark-x",
  ...over,
});

describe("describeTmuxReadFailure", () => {
  it("tmux-failed はコマンド名 / status / stderr を含む (事後に原因を追えること)", () => {
    const text = describeTmuxReadFailure(tmuxFailed());
    expect(text).toContain("capture-pane");
    expect(text).toContain("status=1");
    expect(text).toContain("can't find pane: ark-x");
  });

  it("tmux-failed で spawn 自体が失敗した場合は errno code と message を含む", () => {
    const text = describeTmuxReadFailure(
      tmuxFailed({
        status: null,
        code: "ENOENT",
        stderr: "",
        message: "spawnSync tmux ENOENT",
      })
    );
    expect(text).toContain("code=ENOENT");
    expect(text).toContain("spawnSync tmux ENOENT");
  });

  it("tmux-failed で timeout により signal で落ちた場合は signal を含む", () => {
    const text = describeTmuxReadFailure(
      tmuxFailed({ status: null, signal: "SIGTERM", code: "ETIMEDOUT" })
    );
    expect(text).toContain("signal=SIGTERM");
    expect(text).toContain("code=ETIMEDOUT");
  });

  it("失敗要因ごとに異なる説明を返す", () => {
    const kinds: TmuxReadFailure[] = [
      { kind: "no-session" },
      { kind: "not-set" },
      { kind: "no-buffer" },
      { kind: "invalid-pane-pid", raw: "abc" },
      { kind: "proc-error", code: "EACCES", message: "permission denied" },
      { kind: "unsupported-platform", platform: "darwin" },
      tmuxFailed(),
    ];
    const texts = kinds.map(describeTmuxReadFailure);
    expect(new Set(texts).size).toBe(kinds.length);
    expect(texts[3]).toContain('"abc"');
    expect(texts[4]).toContain("EACCES");
    expect(texts[5]).toContain("darwin");
  });
});

describe("TmuxReadFailureReporter", () => {
  const fail = (f: TmuxReadFailure): TmuxReadResult<string> => ({
    ok: false,
    failure: f,
  });
  const ok: TmuxReadResult<string> = { ok: true, value: "x" };

  it("同じ key の同じ失敗は 1 回しか出力しない", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", fail(tmuxFailed()));
    reporter.report("s1", fail(tmuxFailed()));
    reporter.report("s1", fail(tmuxFailed()));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("[Preview]");
    expect(log.mock.calls[0]?.[0]).toContain("s1");
    expect(log.mock.calls[0]?.[0]).toContain("can't find pane: ark-x");
  });

  it("失敗内容が変わったら再度出力する", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", fail(tmuxFailed()));
    reporter.report("s1", fail(tmuxFailed({ stderr: "server exited" })));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain("server exited");
  });

  it("key が異なれば独立に出力する", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", fail(tmuxFailed()));
    reporter.report("s2", fail(tmuxFailed()));
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("成功に戻ったら回復を 1 行出し、その後の同じ失敗は再び出力する", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", fail(tmuxFailed()));
    reporter.report("s1", ok);
    reporter.report("s1", ok);
    reporter.report("s1", fail(tmuxFailed()));
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[1]?.[0]).toMatch(/回復/);
  });

  it("一度も失敗していない key の成功は何も出力しない", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", ok);
    expect(log).not.toHaveBeenCalled();
  });

  it("forget した key は記録が消え、次の同じ失敗を再び出力する", () => {
    const log = vi.fn();
    const reporter = new TmuxReadFailureReporter("[Preview]", log);
    reporter.report("s1", fail(tmuxFailed()));
    reporter.forget("s1");
    reporter.report("s1", fail(tmuxFailed()));
    expect(log).toHaveBeenCalledTimes(2);
  });
});
