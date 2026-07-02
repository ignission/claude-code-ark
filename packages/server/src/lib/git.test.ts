/**
 * git.ts createWorktree / deleteWorktree のテスト (Issue #213)
 *
 * exec / fs をモックして、git コマンドの呼び出し内容と
 * ブランチ後始末・残骸ディレクトリ後始末のロジックを検証する。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// child_process.exec をモック化（git.ts は promisify(exec) 経由で利用する）
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// fs をモック化（existsSync / promises.rm のみ使用）
vi.mock("node:fs", () => {
  const fsMock = {
    existsSync: vi.fn(),
    promises: {
      rm: vi.fn(),
    },
  };
  return { default: fsMock };
});

import { exec } from "node:child_process";
import fs from "node:fs";
import { createWorktree, deleteWorktree } from "./git.js";

const mockedExec = vi.mocked(exec);

const REPO = "/repo";
const WT = "/repo-doc";

/** exec に対する応答ルール（match した最初のルールが応答する） */
interface ExecRule {
  match: RegExp;
  respond: (cmd: string) => { stdout: string } | Error;
}

let execRules: ExecRule[] = [];
let execCalls: string[] = [];

/**
 * git worktree list --porcelain 形式の出力を組み立てる
 */
function porcelain(
  entries: Array<{ path: string; branch?: string; detached?: boolean }>
): string {
  return `${entries
    .map(e =>
      [
        `worktree ${e.path}`,
        "HEAD abc1234567890",
        e.detached ? "detached" : `branch refs/heads/${e.branch}`,
        "",
      ].join("\n")
    )
    .join("\n")}\n`;
}

/** exec の失敗を exit code 付きで模倣する（promisify(exec) は error.code に exit code を載せる） */
function execError(message: string, code = 1): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

/** ブランチ後始末系のコマンド（merge-base / branch 操作）が呼ばれたか */
function branchCleanupAttempted(): boolean {
  return execCalls.some(
    c => c.includes("merge-base") || c.startsWith("git branch")
  );
}

/** getGitRoot / isGitRepository / worktree list の基本ルール */
function baseRules(
  listResponse: () => string = () =>
    porcelain([
      { path: REPO, branch: "main" },
      { path: WT, branch: "doc" },
    ])
): ExecRule[] {
  return [
    {
      match: /rev-parse --show-toplevel/,
      respond: () => ({ stdout: `${REPO}\n` }),
    },
    {
      match: /rev-parse --is-inside-work-tree/,
      respond: () => ({ stdout: "true\n" }),
    },
    {
      match: /worktree list --porcelain/,
      respond: () => ({ stdout: listResponse() }),
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  execRules = [];
  execCalls = [];

  // console 出力を抑制しつつ呼び出しを検証可能にする
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  // exec: ルールにマッチした応答を promisify 互換のコールバックで返す
  mockedExec.mockImplementation(((
    cmd: string,
    opts: unknown,
    callback?: (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void
  ) => {
    const cb = (typeof opts === "function" ? opts : callback) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    execCalls.push(cmd);
    const rule = execRules.find(r => r.match.test(cmd));
    if (!rule) {
      cb(new Error(`unexpected command: ${cmd}`));
      return;
    }
    const res = rule.respond(cmd);
    if (res instanceof Error) {
      cb(res);
    } else {
      cb(null, { stdout: res.stdout, stderr: "" });
    }
  }) as never);

  // fs デフォルト: パスは存在し、rm は成功する
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

describe("createWorktree", () => {
  it("同名ブランチに固有コミットがなければ削除してから新規ブランチで作成する", async () => {
    let targetExists = false;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      p === WT ? targetExists : true
    );
    execRules = [
      ...baseRules(() =>
        targetExists
          ? porcelain([
              { path: REPO, branch: "main" },
              { path: WT, branch: "doc" },
            ])
          : porcelain([{ path: REPO, branch: "main" }])
      ),
      { match: /show-ref --verify/, respond: () => ({ stdout: "" }) },
      { match: /merge-base --is-ancestor/, respond: () => ({ stdout: "" }) },
      { match: /^git branch -D /, respond: () => ({ stdout: "" }) },
      {
        match: /worktree add/,
        respond: () => {
          targetExists = true;
          return { stdout: "" };
        },
      },
    ];

    const worktree = await createWorktree(REPO, "doc", "main");

    expect(worktree.path).toBe(WT);
    // 到達可能性は baseRef (main) に対して明示的に検証される
    expect(execCalls).toContain('git merge-base --is-ancestor "doc" "main"');
    expect(execCalls).toContain('git branch -D "doc"');
    const addCall = execCalls.find(c => c.includes("worktree add"));
    expect(addCall).toContain('-b "doc"');
  });

  it("固有コミットを持つ同名ブランチには -b なしで attach する", async () => {
    let targetExists = false;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      p === WT ? targetExists : true
    );
    execRules = [
      ...baseRules(() =>
        targetExists
          ? porcelain([
              { path: REPO, branch: "main" },
              { path: WT, branch: "doc" },
            ])
          : porcelain([{ path: REPO, branch: "main" }])
      ),
      { match: /show-ref --verify/, respond: () => ({ stdout: "" }) },
      {
        match: /merge-base --is-ancestor/,
        respond: () => execError("not an ancestor", 1),
      },
      { match: /branch -r --contains/, respond: () => ({ stdout: "" }) },
      {
        match: /worktree add/,
        respond: () => {
          targetExists = true;
          return { stdout: "" };
        },
      },
    ];

    const worktree = await createWorktree(REPO, "doc");

    expect(worktree.path).toBe(WT);
    const addCall = execCalls.find(c => c.includes("worktree add"));
    expect(addCall).toBeDefined();
    expect(addCall).not.toContain("-b");
    expect(addCall).toContain(`"${WT}" "doc"`);
    // 到達可能性を証明できないブランチは削除されない
    expect(execCalls.some(c => c.startsWith("git branch -D"))).toBe(false);
  });

  it("同名ブランチが別worktreeでチェックアウト済みなら使用中エラーを投げる", async () => {
    vi.mocked(fs.existsSync).mockImplementation(p => p !== WT);
    execRules = [
      ...baseRules(() =>
        porcelain([
          { path: REPO, branch: "main" },
          { path: "/repo-doc-old", branch: "doc" },
        ])
      ),
      { match: /show-ref --verify/, respond: () => ({ stdout: "" }) },
    ];

    await expect(createWorktree(REPO, "doc")).rejects.toThrow(/使用中/);
    expect(execCalls.some(c => c.includes("worktree add"))).toBe(false);
  });

  it("ブランチが存在しなければ従来どおり -b で新規作成する", async () => {
    let targetExists = false;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      p === WT ? targetExists : true
    );
    execRules = [
      ...baseRules(() =>
        targetExists
          ? porcelain([
              { path: REPO, branch: "main" },
              { path: WT, branch: "doc" },
            ])
          : porcelain([{ path: REPO, branch: "main" }])
      ),
      {
        // show-ref は「存在しない」場合 exit 1
        match: /show-ref --verify/,
        respond: () => execError("branch not found", 1),
      },
      {
        match: /worktree add/,
        respond: () => {
          targetExists = true;
          return { stdout: "" };
        },
      },
    ];

    const worktree = await createWorktree(REPO, "doc");

    expect(worktree.path).toBe(WT);
    const addCall = execCalls.find(c => c.includes("worktree add"));
    expect(addCall).toContain('-b "doc"');
    // ブランチ後始末は試行されない
    expect(branchCleanupAttempted()).toBe(false);
  });

  it("ブランチ存在確認が exit 1 以外で失敗した場合は握りつぶさず伝播する", async () => {
    vi.mocked(fs.existsSync).mockImplementation(p => p !== WT);
    execRules = [
      ...baseRules(() => porcelain([{ path: REPO, branch: "main" }])),
      {
        match: /show-ref --verify/,
        respond: () => execError("fatal: not a git repository", 128),
      },
    ];

    await expect(createWorktree(REPO, "doc")).rejects.toThrow(
      /not a git repository/
    );
    expect(execCalls.some(c => c.includes("worktree add"))).toBe(false);
  });

  it("作成先ディレクトリが既に存在する場合は案内付きのエラーを投げる", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    execRules = baseRules();

    await expect(createWorktree(REPO, "doc")).rejects.toThrow(/既に存在/);
  });

  it("worktree add が失敗した場合は console.error に記録する", async () => {
    vi.mocked(fs.existsSync).mockImplementation(p => p !== WT);
    execRules = [
      ...baseRules(() => porcelain([{ path: REPO, branch: "main" }])),
      {
        match: /show-ref --verify/,
        respond: () => execError("branch not found", 1),
      },
      {
        match: /worktree add/,
        respond: () => new Error("fatal: could not create work tree dir"),
      },
    ];

    await expect(createWorktree(REPO, "doc")).rejects.toThrow(
      /could not create work tree dir/
    );
    expect(console.error).toHaveBeenCalled();
  });
});

describe("deleteWorktree", () => {
  it("HEAD から到達可能なブランチは worktree 削除後に削除する", async () => {
    execRules = [
      ...baseRules(),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
      { match: /merge-base --is-ancestor/, respond: () => ({ stdout: "" }) },
      { match: /^git branch -D /, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("deleted");
    // 到達可能性は HEAD に対して明示的に検証される
    expect(execCalls).toContain('git merge-base --is-ancestor "doc" "HEAD"');
    expect(execCalls).toContain('git branch -D "doc"');
  });

  it("HEAD 未マージでもリモートに取り込み済みなら削除する", async () => {
    execRules = [
      ...baseRules(),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
      {
        match: /merge-base --is-ancestor/,
        respond: () => execError("not an ancestor", 1),
      },
      {
        match: /branch -r --contains/,
        respond: () => ({ stdout: "  origin/main\n" }),
      },
      { match: /^git branch -D /, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("deleted");
    expect(execCalls).toContain('git branch -D "doc"');
  });

  it("固有コミットを持つ可能性のあるブランチは保持して理由を返す", async () => {
    execRules = [
      ...baseRules(),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
      {
        match: /merge-base --is-ancestor/,
        respond: () => execError("not an ancestor", 1),
      },
      { match: /branch -r --contains/, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("kept");
    expect(result.branchKeptReason).toBeTruthy();
    expect(execCalls.some(c => c.startsWith("git branch -D"))).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("到達可能なのに branch -D が失敗した場合は削除失敗として保持する", async () => {
    execRules = [
      ...baseRules(),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
      { match: /merge-base --is-ancestor/, respond: () => ({ stdout: "" }) },
      {
        match: /^git branch -D /,
        respond: () => execError("error: Cannot delete branch 'doc'", 1),
      },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("kept");
    expect(result.branchKeptReason).toMatch(/削除に失敗/);
    // 削除失敗を「未マージ」と誤分類してリモート確認へ進まない
    expect(execCalls.some(c => c.includes("branch -r --contains"))).toBe(false);
  });

  it("到達可能性判定が exit 1 以外で失敗した場合は異常として保持する", async () => {
    execRules = [
      ...baseRules(),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
      {
        match: /merge-base --is-ancestor/,
        respond: () => execError("fatal: bad revision", 128),
      },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("kept");
    expect(result.branchKeptReason).toMatch(/判定に失敗/);
    // リポジトリ異常時はそれ以上ブランチ操作を重ねない
    expect(execCalls.some(c => c.includes("branch -r --contains"))).toBe(false);
    expect(execCalls.some(c => c.startsWith("git branch -D"))).toBe(false);
  });

  it("不正な形式のブランチ名は後始末をスキップして理由を返す", async () => {
    execRules = [
      ...baseRules(() =>
        porcelain([
          { path: REPO, branch: "main" },
          { path: WT, branch: "doc;evil" },
        ])
      ),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("kept");
    expect(result.branchKeptReason).toBeTruthy();
    // 不正なブランチ名は shell に渡さない（コマンドインジェクション対策）
    expect(branchCleanupAttempted()).toBe(false);
  });

  it("detached の worktree はブランチ削除をスキップする", async () => {
    execRules = [
      ...baseRules(() =>
        porcelain([
          { path: REPO, branch: "main" },
          { path: WT, detached: true },
        ])
      ),
      { match: /worktree remove/, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(result.branchCleanup).toBe("skipped");
    expect(branchCleanupAttempted()).toBe(false);
  });

  it("worktree remove 失敗時は残骸ディレクトリ削除と prune で後始末する", async () => {
    let wtExists = true;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      p === WT ? wtExists : true
    );
    vi.mocked(fs.promises.rm).mockImplementation(async () => {
      wtExists = false;
    });
    execRules = [
      ...baseRules(),
      {
        match: /worktree remove/,
        respond: () =>
          new Error("fatal: failed to delete '/repo-doc': Directory not empty"),
      },
      { match: /worktree prune/, respond: () => ({ stdout: "" }) },
      { match: /merge-base --is-ancestor/, respond: () => ({ stdout: "" }) },
      { match: /^git branch -D /, respond: () => ({ stdout: "" }) },
    ];

    const result = await deleteWorktree(REPO, WT);

    expect(fs.promises.rm).toHaveBeenCalledWith(WT, {
      recursive: true,
      force: true,
    });
    expect(execCalls.some(c => c.includes("worktree prune"))).toBe(true);
    expect(console.error).toHaveBeenCalled();
    expect(result.branchCleanup).toBe("deleted");
  });

  it("Directory not empty 以外の worktree remove 失敗は後始末せず即エラーにする", async () => {
    execRules = [
      ...baseRules(),
      {
        match: /worktree remove/,
        respond: () =>
          execError("fatal: cannot remove a locked working tree", 128),
      },
    ];

    await expect(deleteWorktree(REPO, WT)).rejects.toThrow(
      /locked working tree/
    );
    // git が明示的に拒否したケースでは残骸扱いの rm -rf をしない
    expect(fs.promises.rm).not.toHaveBeenCalled();
    expect(execCalls.some(c => c.includes("worktree prune"))).toBe(false);
  });

  it("後始末にも失敗した場合は元のエラーを投げてブランチ削除は行わない", async () => {
    vi.mocked(fs.promises.rm).mockRejectedValue(new Error("EACCES"));
    execRules = [
      ...baseRules(),
      {
        match: /worktree remove/,
        respond: () =>
          new Error("fatal: failed to delete '/repo-doc': Directory not empty"),
      },
      { match: /worktree prune/, respond: () => ({ stdout: "" }) },
    ];

    await expect(deleteWorktree(REPO, WT)).rejects.toThrow(
      /Directory not empty/
    );
    // 後始末（rm）は試行されるが、失敗したらブランチ削除には進まない
    expect(fs.promises.rm).toHaveBeenCalled();
    expect(branchCleanupAttempted()).toBe(false);
  });

  it("メインworktreeは削除できない", async () => {
    execRules = baseRules();

    await expect(deleteWorktree(REPO, REPO)).rejects.toThrow(
      /Cannot delete the main worktree/
    );
  });
});
