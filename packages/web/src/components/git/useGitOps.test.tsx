// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitApi } from "@/lib/git-api";
import { click, flush, mount, typeInto, unmountAll } from "./test-helpers";
import { type GitOpsActions, useGitOps } from "./useGitOps";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function makeApi(overrides: Partial<GitApi> = {}): GitApi {
  const ok = async () => ({ ok: true as const });
  return {
    log: vi.fn(),
    refs: vi.fn(),
    status: vi.fn(),
    commit: vi.fn(),
    fileDiff: vi.fn(),
    fingerprint: vi.fn(),
    createBranch: vi.fn(ok),
    renameBranch: vi.fn(ok),
    deleteBranch: vi.fn(async () => ({
      ok: true as const,
      sha: "abc1234def",
      upstream: { remote: "origin", merge: "refs/heads/release" },
    })),
    deleteRemoteBranch: vi.fn(ok),
    fetch: vi.fn(ok),
    pull: vi.fn(ok),
    push: vi.fn(async () => ({
      ok: true as const,
      remote: "origin",
      remoteBranch: "main",
    })),
    ...overrides,
  } as GitApi;
}

let actions: GitOpsActions;
let busy: string | null;

function Harness({ api, onChanged }: { api: GitApi; onChanged: () => void }) {
  const ops = useGitOps(api, "main", onChanged);
  actions = ops.actions;
  busy = ops.busy;
  return <>{ops.dialogs}</>;
}

function setup(overrides: Partial<GitApi> = {}) {
  const api = makeApi(overrides);
  const onChanged = vi.fn();
  mount(<Harness api={api} onChanged={onChanged} />);
  return { api, onChanged };
}

const byText = (text: string) =>
  [...document.querySelectorAll("button")].find(
    b => b.textContent?.trim() === text
  );

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(unmountAll);

describe("useGitOps", () => {
  it("取り込み済みのブランチはそのまま消し、元に戻すで追跡先ごと戻す", async () => {
    const { api, onChanged } = setup();
    actions.deleteBranch("done");
    await flush();
    expect(api.deleteBranch).toHaveBeenCalledWith("done", false);
    expect(onChanged).toHaveBeenCalled();
    const [, opts] = toast.success.mock.calls[0];
    opts.action.onClick();
    await flush();
    expect(api.createBranch).toHaveBeenCalledWith("done", "abc1234def", {
      remote: "origin",
      merge: "refs/heads/release",
    });
  });

  it("未マージなら確かめてから強制で消す", async () => {
    const deleteBranch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "取り込まれていないコミットがあります",
        notMerged: true,
      })
      .mockResolvedValueOnce({ ok: true, sha: "abc1234" });
    const { api } = setup({ deleteBranch });
    actions.deleteBranch("wip");
    await flush();
    expect(document.body.textContent).toContain("wip を強制削除しますか?");
    click(byText("削除"));
    await flush();
    expect(api.deleteBranch).toHaveBeenLastCalledWith("wip", true);
  });

  it("名前の入力: 失敗の理由をダイアログに出し、通れば閉じる", async () => {
    const createBranch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "ブランチ x は既にあります" })
      .mockResolvedValueOnce({ ok: true });
    const { onChanged } = setup({ createBranch });
    actions.createBranchAt("abc1234");
    await flush();
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="ブランチ名"]'
    );
    if (!input) throw new Error("入力欄がありません");
    typeInto(input, "x");
    click(byText("作成"));
    await flush();
    expect(createBranch).toHaveBeenCalledWith("x", "abc1234");
    expect(document.body.textContent).toContain("既にあります");
    typeInto(input, "y");
    click(byText("作成"));
    await flush();
    expect(onChanged).toHaveBeenCalled();
    expect(document.querySelector('input[aria-label="ブランチ名"]')).toBeNull();
  });

  it("リモートの操作は重ねない。終わったら読み直させる", async () => {
    let finish: (v: { ok: true }) => void = () => {};
    const fetch = vi.fn(
      () => new Promise<{ ok: true }>(resolve => (finish = resolve))
    );
    const { api, onChanged } = setup({ fetch });
    // 描き直す前の続けざまの押下も 1 回にまとめる
    actions.fetch();
    actions.fetch();
    await flush();
    expect(busy).toBe("fetch");
    actions.fetch();
    actions.pull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(api.pull).not.toHaveBeenCalled();
    finish({ ok: true });
    await flush();
    expect(busy).toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("fetch しました");
  });

  it("失敗は toast に出す", async () => {
    setup({
      push: vi.fn(async () => ({ ok: false as const, error: "rejected" })),
    });
    actions.pushBranch("main");
    await flush();
    await flush();
    expect(toast.error).toHaveBeenCalledWith("rejected");
  });

  it("リモートのブランチの削除は確かめてから行う", async () => {
    const { api } = setup();
    actions.deleteRemoteBranch("origin", "origin/feat/x");
    await flush();
    expect(api.deleteRemoteBranch).not.toHaveBeenCalled();
    click(byText("削除"));
    await flush();
    expect(api.deleteRemoteBranch).toHaveBeenCalledWith(
      "origin",
      "origin/feat/x"
    );
  });
});
