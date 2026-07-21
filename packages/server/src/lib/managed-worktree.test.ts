/**
 * managed-worktree の判定ロジックのテスト。
 *
 * 実挙動を見たいので fs はモックせず OS の一時ディレクトリを実際に作って検証する。
 * 例外的に「realpath が ENOENT 以外の errno で失敗する」ケースだけは実環境で
 * 安定して再現できない (root 実行だと chmod 000 を素通りする) ため、
 * fs 依存を注入して検証する。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkManagedWorktree,
  describeWorktreeFailure,
  resolveWorktreeRealPath,
} from "./managed-worktree.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ark-managed-wt-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** `.git` ディレクトリを持つ worktree 相当のディレクトリを作る */
function makeWorktree(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("resolveWorktreeRealPath", () => {
  it("実在する worktree は realpath 正規化して返す", () => {
    const dir = makeWorktree("wt");

    const result = resolveWorktreeRealPath(path.join(dir, "."));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.realPath).toBe(fs.realpathSync(dir));
  });

  it("削除済み worktree は worktree-missing として区別する (null に潰さない)", () => {
    const gone = path.join(tmpRoot, "deleted-worktree");

    const result = resolveWorktreeRealPath(gone);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("worktree-missing");
    }
  });

  it("ENOENT 以外の FS エラーは fs-error として errno を保持する", () => {
    const failing = {
      realpathSync: () => {
        const err = new Error(
          "EACCES: permission denied"
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    };

    const result = resolveWorktreeRealPath("/whatever", { fs: failing });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("fs-error");
      if (result.failure.kind === "fs-error") {
        expect(result.failure.code).toBe("EACCES");
      }
    }
  });

  it("異常に長いパスは realpath を呼ばずに path-too-long で弾く", () => {
    const result = resolveWorktreeRealPath("/a".repeat(3000));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("path-too-long");
  });
});

describe("checkManagedWorktree", () => {
  it("allowedRepos 未設定なら .git を持つディレクトリを許可する", () => {
    const dir = makeWorktree("wt");

    expect(checkManagedWorktree(dir, { allowedRepos: [] }).ok).toBe(true);
  });

  it("ファイル (ディレクトリでない) は not-directory として区別する", () => {
    const file = path.join(tmpRoot, "a-file");
    fs.writeFileSync(file, "x");

    const result = checkManagedWorktree(file, { allowedRepos: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("not-directory");
  });

  it(".git を持たないディレクトリは not-a-worktree として区別する", () => {
    const dir = path.join(tmpRoot, "plain");
    fs.mkdirSync(dir);

    const result = checkManagedWorktree(dir, { allowedRepos: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("not-a-worktree");
  });

  it("allowedRepos 設定時、許可外の repo は repo-not-allowed として区別する", () => {
    const dir = makeWorktree("wt");

    const result = checkManagedWorktree(dir, {
      allowedRepos: ["/somewhere/else"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("repo-not-allowed");
  });
});

describe("describeWorktreeFailure", () => {
  it("削除済みと『管理外』を別々の文言で説明する", () => {
    const missing = describeWorktreeFailure({ kind: "worktree-missing" });
    const notWorktree = describeWorktreeFailure({ kind: "not-a-worktree" });

    expect(missing).not.toBe(notWorktree);
    // 「消えている」ことが読み取れる文言であること (原因究明の手掛かりになる)
    expect(missing).toContain("削除");
  });

  it("fs-error は errno を文言に含める (事後に原因を追えるようにする)", () => {
    const text = describeWorktreeFailure({
      kind: "fs-error",
      code: "EACCES",
      message: "permission denied",
    });

    expect(text).toContain("EACCES");
  });
});
