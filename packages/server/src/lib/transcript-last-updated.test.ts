/**
 * readTranscriptLastUpdatedAt の単体テスト。
 *
 * 経路 (projectsDirFor → encodeProjectDir → pickLatestJsonl → stat) は
 * 差し替えた io で検証し、既定の io だけ実ファイルで確かめる。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCwdCache } from "./claude-projects.js";
import {
  readTranscriptLastUpdatedAt,
  type TranscriptIo,
} from "./transcript-last-updated.js";

const tmpDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-transcript-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearCwdCache();
});

describe("readTranscriptLastUpdatedAt", () => {
  it("現行 JSONL の mtime を返す", () => {
    const io: TranscriptIo = {
      pickLatestJsonl: () => "/cfg/projects/-wt-app/current.jsonl",
      statMtimeMs: () => 1_700_000_000_123,
    };
    expect(readTranscriptLastUpdatedAt("/wt/app", "/cfg", io)).toBe(
      1_700_000_000_123
    );
  });

  it("JSONL が無ければ null (不明)", () => {
    const io: TranscriptIo = {
      pickLatestJsonl: () => null,
      statMtimeMs: () => 1,
    };
    expect(readTranscriptLastUpdatedAt("/wt/app", "/cfg", io)).toBeNull();
  });

  it("ディレクトリが無く pickLatestJsonl が投げても null (1秒 polling を落とさない)", () => {
    const io: TranscriptIo = {
      pickLatestJsonl: () => {
        throw new Error("ENOENT: no such file or directory");
      },
      statMtimeMs: () => 1,
    };
    expect(readTranscriptLastUpdatedAt("/wt/app", "/cfg", io)).toBeNull();
  });

  it("stat が投げても null (削除レース)", () => {
    const io: TranscriptIo = {
      pickLatestJsonl: () => "/cfg/projects/-wt-app/gone.jsonl",
      statMtimeMs: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };
    expect(readTranscriptLastUpdatedAt("/wt/app", "/cfg", io)).toBeNull();
  });

  it("mtime が数値にならなければ null", () => {
    const io: TranscriptIo = {
      pickLatestJsonl: () => "/cfg/projects/-wt-app/current.jsonl",
      statMtimeMs: () => Number.NaN,
    };
    expect(readTranscriptLastUpdatedAt("/wt/app", "/cfg", io)).toBeNull();
  });

  it("configDir 配下の projects/<encodeProjectDir(worktree)> を見る", () => {
    const seen: Array<[string, string]> = [];
    const io: TranscriptIo = {
      pickLatestJsonl: (dir, expectedCwd) => {
        seen.push([dir, expectedCwd]);
        return null;
      },
      statMtimeMs: () => 1,
    };
    readTranscriptLastUpdatedAt("/home/me/dev/app.v2", "/cfg/claude-work", io);
    expect(seen).toEqual([
      ["/cfg/claude-work/projects/-home-me-dev-app-v2", "/home/me/dev/app.v2"],
    ]);
  });

  it("既定の io は実ファイルの mtime を返し、JSONL が無ければ null", () => {
    const configDir = makeConfigDir();
    const worktreePath = path.join(configDir, "wt");
    const projectDir = path.join(
      configDir,
      "projects",
      worktreePath.replace(/[^a-zA-Z0-9]/g, "-")
    );
    fs.mkdirSync(projectDir, { recursive: true });
    // ディレクトリはあるが JSONL がまだ無い状態 (起動直後)
    expect(readTranscriptLastUpdatedAt(worktreePath, configDir)).toBeNull();

    const file = path.join(projectDir, "session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ cwd: worktreePath })}\n`);
    expect(readTranscriptLastUpdatedAt(worktreePath, configDir)).toBe(
      fs.statSync(file).mtimeMs
    );
  });

  it("既定の io はディレクトリが無ければ null", () => {
    const configDir = makeConfigDir();
    expect(
      readTranscriptLastUpdatedAt("/does/not/exist", configDir)
    ).toBeNull();
  });
});
