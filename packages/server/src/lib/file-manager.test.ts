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
    const dir = await mkdtemp("/tmp/ark-fm-abs-");
    try {
      const abs = path.join(dir, "a.txt");
      await writeFile(abs, "hi");
      const r = await readFileFromWorktree(wt, abs);
      expect(r.content).toBe("hi");
      expect(r.editable).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(".git 配下は editable: false", async () => {
    const r = await readFileFromWorktree(wt, ".git/config");
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

  it.each([0o664, 0o600])("mode %o を umask に関わらず保つ", async mode => {
    const f = path.join(wt, "m.txt");
    await writeFile(f, "old");
    await chmod(f, mode);
    const st = await stat(f);
    const r = await writeFileToWorktree(wt, "m.txt", "new", st.mtimeMs);
    expect(r.ok).toBe(true);
    expect((await stat(f)).mode & 0o7777).toBe(mode);
  });

  it("バイナリ (.png) への書き込みは拒否しファイルは変わらない", async () => {
    const f = path.join(wt, "i.png");
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    await writeFile(f, bin);
    const st = await stat(f);
    const r = await writeFileToWorktree(wt, "i.png", "text", st.mtimeMs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("error");
    expect((await readFile(f)).equals(bin)).toBe(true);
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

  it("未追跡 dir 配下は ?", async () => {
    await mkdir(path.join(wt, "newdir"));
    await writeFile(path.join(wt, "newdir", "x.txt"), "x");
    const top = await listDirectory(wt, "");
    expect(top.entries.find(e => e.name === "newdir")?.gitStatus).toBe("?");
    const inner = await listDirectory(wt, "newdir");
    expect(inner.entries[0]).toMatchObject({ name: "x.txt", gitStatus: "?" });
  });

  it("staged の新規ファイルは A", async () => {
    await writeFile(path.join(wt, "staged.txt"), "s");
    git("add", "staged.txt");
    const { entries } = await listDirectory(wt, "");
    expect(entries.find(e => e.name === "staged.txt")?.gitStatus).toBe("A");
  });

  it("削除された追跡ファイルは親 dir が M になる", async () => {
    await mkdir(path.join(wt, "sub"));
    await writeFile(path.join(wt, "sub", "gone.txt"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await rm(path.join(wt, "sub", "gone.txt"));
    const { entries } = await listDirectory(wt, "");
    expect(entries.find(e => e.name === "sub")?.gitStatus).toBe("M");
  });

  it("2000 件で打ち切る", async () => {
    for (let i = 0; i < 2005; i++) {
      await writeFile(path.join(wt, `f${String(i).padStart(4, "0")}`), "");
    }
    const { entries, truncated } = await listDirectory(wt, "");
    expect(entries).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it("絶対パスの dirPath は throw", async () => {
    await expect(listDirectory(wt, "/tmp")).rejects.toThrow();
  });

  it(".. を含む dirPath は throw", async () => {
    await expect(listDirectory(wt, "../")).rejects.toThrow();
  });
});

describe("文字コードと保存の直列化", () => {
  it("UTF-8 として読めないファイルは editable: false で、書き込みも拒否する", async () => {
    const f = path.join(wt, "sjis.txt");
    // 「日本語」の Shift_JIS
    const bytes = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
    await writeFile(f, bytes);
    const r = await readFileFromWorktree(wt, "sjis.txt");
    expect(r.editable).toBe(false);
    const w = await writeFileToWorktree(wt, "sjis.txt", "x", r.mtimeMs);
    expect(w.ok).toBe(false);
    expect(Buffer.compare(await readFile(f), bytes)).toBe(0);
  });

  it("BOM 付きの UTF-8 は editable: false", async () => {
    await writeFile(
      path.join(wt, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\n")])
    );
    expect((await readFileFromWorktree(wt, "bom.txt")).editable).toBe(false);
  });

  it("同じ mtime を添えた同時の保存は、後の 1 件が conflict になる", async () => {
    const f = path.join(wt, "a.txt");
    await writeFile(f, "old");
    const old = new Date(Date.now() - 60_000);
    await utimes(f, old, old);
    const before = (await stat(f)).mtimeMs;
    const [a, b] = await Promise.all([
      writeFileToWorktree(wt, "a.txt", "first", before),
      writeFileToWorktree(wt, "a.txt", "second", before),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: "conflict" });
    expect(await readFile(f, "utf-8")).toBe("first");
  });

  it("保存直後の一覧に、保存後の git 状態が出る", async () => {
    const f = path.join(wt, "tracked.txt");
    await writeFile(f, "1");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const first = await listDirectory(wt, "");
    expect(first.entries.find(e => e.name === "tracked.txt")?.gitStatus).toBe(
      undefined
    );
    const { mtimeMs } = await stat(f);
    const w = await writeFileToWorktree(wt, "tracked.txt", "22", mtimeMs);
    expect(w.ok).toBe(true);
    const second = await listDirectory(wt, "");
    expect(second.entries.find(e => e.name === "tracked.txt")?.gitStatus).toBe(
      "M"
    );
  });
});
