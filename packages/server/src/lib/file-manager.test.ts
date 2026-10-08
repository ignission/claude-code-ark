import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listDirectory,
  MAX_EDITABLE_SIZE,
  readFileFromWorktree,
  writeFileToWorktree,
} from "./file-manager.js";

let root: string;
let wt: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: wt, stdio: "ignore" });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ark-fm-")));
  wt = path.join(root, "wt");
  await mkdir(wt);
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readFileFromWorktree", () => {
  it("mtimeMs と editable: true を返す", async () => {
    await writeFile(path.join(wt, "a.ts"), "export {};\n");
    const r = await readFileFromWorktree(wt, "a.ts");
    expect(r.mtimeMs).toBeGreaterThan(0);
    expect(r.editable).toBe(true);
  });

  it("3MB のファイルは editable: false", async () => {
    await writeFile(path.join(wt, "big.txt"), "a".repeat(3 * 1024 * 1024));
    const r = await readFileFromWorktree(wt, "big.txt");
    expect(r.editable).toBe(false);
  });

  it("絶対パス (/tmp 配下) は editable: false", async () => {
    const abs = path.join(wt, "a.txt");
    await writeFile(abs, "hi");
    const r = await readFileFromWorktree(wt, abs);
    expect(r.editable).toBe(false);
  });

  it("拡張子表に無いテキストファイルは text/plain で読める", async () => {
    await writeFile(path.join(wt, ".gitattributes"), "* text=auto\n");
    const r = await readFileFromWorktree(wt, ".gitattributes");
    expect(r.mimeType).toBe("text/plain");
    expect(r.content).toBe("* text=auto\n");
    expect(r.editable).toBe(true);
  });

  it("NUL を含む未知拡張子はバイナリ扱い", async () => {
    await writeFile(path.join(wt, "x.bin"), Buffer.from([1, 0, 2]));
    const r = await readFileFromWorktree(wt, "x.bin");
    expect(r.mimeType).toBe("application/octet-stream");
    expect(r.content).toBe("");
    expect(r.editable).toBe(false);
  });
});

describe("writeFileToWorktree", () => {
  it("書けて mtimeMs が返り、一時ファイルが残らない", async () => {
    const f = path.join(wt, "a.txt");
    await writeFile(f, "old");
    const old = new Date(Date.now() - 60_000);
    await utimes(f, old, old);
    const before = (await stat(f)).mtimeMs;

    const r = await writeFileToWorktree(wt, "a.txt", "new", before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mtimeMs).toBeGreaterThan(before);
    expect(await readFile(f, "utf-8")).toBe("new");
    expect((await readdir(wt)).filter(n => n.includes("ark-tmp"))).toEqual([]);
  });

  it("mode を保つ", async () => {
    const f = path.join(wt, "run.sh");
    await writeFile(f, "#!/bin/sh\n");
    await chmod(f, 0o755);
    const st = await stat(f);
    const r = await writeFileToWorktree(
      wt,
      "run.sh",
      "#!/bin/sh\necho\n",
      st.mtimeMs
    );
    expect(r.ok).toBe(true);
    expect((await stat(f)).mode & 0o777).toBe(0o755);
  });

  it("mtime が違うと conflict でファイルは変わらない。force なら書ける", async () => {
    const f = path.join(wt, "a.txt");
    await writeFile(f, "old");
    const st = await stat(f);

    const r = await writeFileToWorktree(wt, "a.txt", "new", st.mtimeMs - 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("conflict");
      if (r.code === "conflict") expect(r.mtimeMs).toBe(st.mtimeMs);
    }
    expect(await readFile(f, "utf-8")).toBe("old");

    const r2 = await writeFileToWorktree(
      wt,
      "a.txt",
      "new",
      st.mtimeMs - 5000,
      true
    );
    expect(r2.ok).toBe(true);
    expect(await readFile(f, "utf-8")).toBe("new");
  });

  describe("拒否", () => {
    beforeEach(async () => {
      await writeFile(path.join(wt, "a.txt"), "old");
      await mkdir(path.join(wt, "dir"));
    });

    async function expectError(rel: string, content = "x") {
      const r = await writeFileToWorktree(wt, rel, content, 0, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("error");
    }

    it("../x", () => expectError("../x"));
    it("絶対パス", async () => {
      const abs = path.join(root, "abs.txt");
      await writeFile(abs, "old");
      await expectError(abs);
      expect(await readFile(abs, "utf-8")).toBe("old");
    });
    it(".git/config", async () => {
      await expectError(".git/config");
    });
    it("存在しないファイル", async () => {
      await expectError("none.txt");
      await expect(stat(path.join(wt, "none.txt"))).rejects.toThrow();
    });
    it("worktree 外を指す symlink", async () => {
      const outside = path.join(root, "outside.txt");
      await writeFile(outside, "old");
      await symlink(outside, path.join(wt, "link.txt"));
      await expectError("link.txt");
      expect(await readFile(outside, "utf-8")).toBe("old");
    });
    it("ディレクトリ", () => expectError("dir"));
    it("2MB 超", async () => {
      await expectError("a.txt", "a".repeat(MAX_EDITABLE_SIZE + 1));
      expect(await readFile(path.join(wt, "a.txt"), "utf-8")).toBe("old");
    });
  });
});

describe("listDirectory", () => {
  it("dir 先・名前順で .git が出ない", async () => {
    await mkdir(path.join(wt, "zdir"));
    await mkdir(path.join(wt, "adir"));
    await writeFile(path.join(wt, "b.txt"), "");
    await writeFile(path.join(wt, "a.txt"), "");
    const { entries, truncated } = await listDirectory(wt, "");
    expect(truncated).toBe(false);
    expect(entries.map(e => `${e.type}:${e.name}`)).toEqual([
      "dir:adir",
      "dir:zdir",
      "file:a.txt",
      "file:b.txt",
    ]);
  });

  it(".gitignore 対象を除く", async () => {
    await writeFile(path.join(wt, ".gitignore"), "node_modules\n");
    await mkdir(path.join(wt, "node_modules"));
    await writeFile(path.join(wt, "keep.txt"), "");
    const { entries } = await listDirectory(wt, "");
    const names = entries.map(e => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).toContain("keep.txt");
  });

  it("変更は M、未追跡は ?、配下に変更のある dir は M", async () => {
    await mkdir(path.join(wt, "sub"));
    await writeFile(path.join(wt, "tracked.txt"), "1");
    await writeFile(path.join(wt, "sub", "in.txt"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await writeFile(path.join(wt, "tracked.txt"), "2");
    await writeFile(path.join(wt, "sub", "in.txt"), "2");
    await writeFile(path.join(wt, "new.txt"), "n");
    const { entries } = await listDirectory(wt, "");
    const by = Object.fromEntries(entries.map(e => [e.name, e.gitStatus]));
    expect(by["tracked.txt"]).toBe("M");
    expect(by["new.txt"]).toBe("?");
    expect(by.sub).toBe("M");
    const sub = await listDirectory(wt, "sub");
    expect(sub.entries[0]).toMatchObject({ name: "in.txt", gitStatus: "M" });
  });

  it("2000 件で打ち切る", async () => {
    for (let i = 0; i < 2005; i++) {
      await writeFile(path.join(wt, `f${String(i).padStart(4, "0")}`), "");
    }
    const { entries, truncated } = await listDirectory(wt, "");
    expect(entries).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it(".. を含む dirPath は throw", async () => {
    await expect(listDirectory(wt, "../")).rejects.toThrow();
  });
});
