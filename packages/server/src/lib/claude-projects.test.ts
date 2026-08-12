/**
 * claude-projects の単体テスト。
 *
 * encodeProjectDir / projectsDirFor はピュア関数。pickLatestJsonl は
 * os.tmpdir() 配下に一時ディレクトリを作って実ファイルで検証する。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCwdCache,
  encodeProjectDir,
  pickLatestJsonl,
  projectsDirFor,
} from "./claude-projects.js";

describe("encodeProjectDir", () => {
  it("絶対パスの / を - に置換する", () => {
    expect(encodeProjectDir("/home/admin/dev/foo")).toBe("-home-admin-dev-foo");
  });

  it("ドットも - に置換する (github.com 等)", () => {
    expect(encodeProjectDir("/home/admin/dev/github.com/org/repo")).toBe(
      "-home-admin-dev-github-com-org-repo"
    );
  });

  it("アンダースコアも - に置換する (sample_3rd regression)", () => {
    expect(encodeProjectDir("/home/admin/dev/Example-Co-Ltd/sample_3rd")).toBe(
      "-home-admin-dev-Example-Co-Ltd-sample-3rd"
    );
  });

  it("空白や + @ などの記号もすべて - に置換する (全非英数置換)", () => {
    // Claude Code 本体は全非英数を '-' にする。部分的な置換実装だと
    // こうしたパスで JSONL ディレクトリが見つからない
    expect(encodeProjectDir("/wt/my app+v2@dev")).toBe("-wt-my-app-v2-dev");
  });

  it("英大文字は保持する", () => {
    expect(encodeProjectDir("/home/admin/Example-Co-Ltd")).toBe(
      "-home-admin-Example-Co-Ltd"
    );
  });

  it("既存のハイフンはそのまま残す", () => {
    expect(encodeProjectDir("/home/admin/foo-bar-baz")).toBe(
      "-home-admin-foo-bar-baz"
    );
  });
});

describe("projectsDirFor", () => {
  it("configDir を渡すとその配下の projects を返す", () => {
    expect(projectsDirFor("/custom/config")).toBe("/custom/config/projects");
  });

  it("configDir 未指定なら ~/.claude/projects", () => {
    expect(projectsDirFor(null)).toBe(
      path.join(os.homedir(), ".claude", "projects")
    );
  });
});

describe("pickLatestJsonl", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-claude-projects-test-"));
    clearCwdCache();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /** mtime を相対秒で設定するヘルパー */
  function setMtime(file: string, offsetSec: number): void {
    const t = new Date(Date.now() + offsetSec * 1000);
    fs.utimesSync(file, t, t);
  }

  it("ディレクトリが無ければ null", () => {
    expect(pickLatestJsonl(path.join(dir, "nope"))).toBeNull();
  });

  it(".jsonl が無ければ null", () => {
    fs.writeFileSync(path.join(dir, "other.txt"), "x");
    expect(pickLatestJsonl(dir)).toBeNull();
  });

  it("mtime 最新の .jsonl を返す", () => {
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    fs.writeFileSync(a, '{"cwd":"/wt"}\n');
    fs.writeFileSync(b, '{"cwd":"/wt"}\n');
    setMtime(a, -60);
    expect(pickLatestJsonl(dir)).toBe(b);
  });

  it("expectedCwd 一致を mtime 降順で優先する (encode 衝突対策)", () => {
    // /a/b と /a.b は同じ encodeProjectDir になる。mtime 最新が別 cwd の
    // transcript でも、cwd 一致側を選ぶ
    const mine = path.join(dir, "mine.jsonl");
    const other = path.join(dir, "other.jsonl");
    fs.writeFileSync(mine, '{"cwd":"/a/b","type":"user"}\n');
    fs.writeFileSync(other, '{"cwd":"/a.b","type":"user"}\n');
    setMtime(mine, -60); // other の方が新しい
    expect(pickLatestJsonl(dir, "/a/b")).toBe(mine);
  });

  it("cwd フィールドの無いファイルは一致候補が無い場合のみ採用される", () => {
    const noCwd = path.join(dir, "no-cwd.jsonl");
    fs.writeFileSync(noCwd, '{"type":"summary"}\n');
    expect(pickLatestJsonl(dir, "/wt")).toBe(noCwd);
  });

  it("cwd 不明の新しいファイルより cwd 一致の古いファイルを優先する", () => {
    // 書きかけの新規ファイル (cwd 行なし) が encode 衝突した別 worktree の
    // ものである可能性があるため、検証できた一致を必ず優先する
    const mine = path.join(dir, "mine.jsonl");
    const unknown = path.join(dir, "unknown.jsonl");
    fs.writeFileSync(mine, '{"cwd":"/wt","type":"user"}\n');
    fs.writeFileSync(unknown, '{"type":"summary"}\n');
    setMtime(mine, -60); // unknown の方が新しい
    expect(pickLatestJsonl(dir, "/wt")).toBe(mine);
  });

  it("既知の不一致ファイルしか無ければ null (別 worktree の会話を出さない)", () => {
    const other = path.join(dir, "other.jsonl");
    fs.writeFileSync(other, '{"cwd":"/different","type":"user"}\n');
    expect(pickLatestJsonl(dir, "/wt")).toBeNull();
  });

  it("先頭行が cwd 無しでも後続行の cwd で検証する", () => {
    // 実 transcript はサマリ行などが先頭に来ることがある
    const f = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      f,
      '{"type":"summary","summary":"t"}\n{"cwd":"/wt","type":"user"}\n'
    );
    const g = path.join(dir, "g.jsonl");
    fs.writeFileSync(g, '{"cwd":"/other","type":"user"}\n');
    setMtime(f, -60); // g の方が新しいが cwd 不一致
    expect(pickLatestJsonl(dir, "/wt")).toBe(f);
  });
});
