import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDiagramPath } from "./diagram-path.js";

let wt: string;

beforeEach(() => {
  wt = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-path-"))
  );
  fs.mkdirSync(path.join(wt, "docs", "diagrams"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
});

describe("resolveDiagramPath", () => {
  it("docs/diagrams 配下の .diagram.html を解決する", () => {
    const result = resolveDiagramPath(wt, "docs/diagrams/a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(
        path.join(wt, "docs", "diagrams", "a.diagram.html")
      );
    }
  });

  it("docs/diagrams を省いた指定も補う", () => {
    const result = resolveDiagramPath(wt, "a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(
        path.join(wt, "docs", "diagrams", "a.diagram.html")
      );
    }
  });

  it("worktree の外へ出る指定を拒否する", () => {
    const result = resolveDiagramPath(wt, "../../etc/passwd.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktree");
  });

  it("絶対パス指定を拒否する", () => {
    const result = resolveDiagramPath(wt, "/etc/x.diagram.html");

    expect(result.ok).toBe(false);
  });

  it(".diagram.html 以外の拡張子を拒否する", () => {
    const result = resolveDiagramPath(wt, "docs/diagrams/a.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(".diagram.html");
  });

  it("docs/diagrams 配下の複数の .. でも拒否する", () => {
    const result = resolveDiagramPath(
      wt,
      "docs/diagrams/../../../etc/passwd.diagram.html"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktree");
  });

  it(".と..の混在でも拒否する", () => {
    const result = resolveDiagramPath(
      wt,
      "docs/diagrams/./../../etc/passwd.diagram.html"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktree");
  });

  it("ファイル名の後に../でも拒否する", () => {
    const result = resolveDiagramPath(
      wt,
      "a.diagram.html/../../../etc/passwd.diagram.html"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktree");
  });

  it("docs/diagrams/./a.diagram.html は解決する", () => {
    const result = resolveDiagramPath(wt, "docs/diagrams/./a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(
        path.join(wt, "docs", "diagrams", "a.diagram.html")
      );
    }
  });

  it("サブディレクトリの図ファイルも解決する", () => {
    const result = resolveDiagramPath(
      wt,
      "docs/diagrams/subdir/b.diagram.html"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(
        path.join(wt, "docs", "diagrams", "subdir", "b.diagram.html")
      );
    }
  });

  it("空文字列を拒否する", () => {
    const result = resolveDiagramPath(wt, "");

    expect(result.ok).toBe(false);
  });

  it("1024字を超えるパスを拒否する", () => {
    const longPath = `${"a".repeat(1025)}.diagram.html`;
    const result = resolveDiagramPath(wt, longPath);

    expect(result.ok).toBe(false);
  });
});
