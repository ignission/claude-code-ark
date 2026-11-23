/**
 * Worktree HEAD Watcher
 *
 * Arkの外 (端末での `git checkout`、`git worktree add` など) でブランチやworktreeが変わったことを検知する。
 * サーバーが worktree:list を配るのはArk経由の操作のときだけなので、これが無いとサイドバーの
 * ブランチ表記は、ブラウザを読み直すまで古いまま残る。
 *
 * - 見るのは、クライアントが一覧を求めたリポジトリだけ (`watch`)。クライアントは接続時に
 *   全リポジトリの一覧を求めるので、サーバーを再起動しても見る対象は戻る
 * - 2秒ごとに、共通のgitディレクトリの `HEAD` と `worktrees/<名前>/HEAD` を読んで指紋にする。
 *   gitはHEADを `HEAD.lock` からのrenameで書き換えるので、ファイルへの `fs.watch` は
 *   1回で外れる。読むのは数十バイトのファイル数個なので、gitを起動せずに済むpollingにした
 * - 指紋が変わったときだけ `onChange` を呼ぶ。初めて読んだ指紋では呼ばない
 *   (直前にクライアントへ一覧を返している)
 * - 読めなくなったリポジトリ (消された、gitでなくなった) は見る対象から外す。
 *   クライアントが一覧を求め直せば `watch` で戻る
 */

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const WORKTREE_HEAD_INTERVAL_MS = 2_000;

/** リポジトリの共通のgitディレクトリ (`git rev-parse --git-common-dir`) を絶対パスで返す */
export function resolveGitCommonDir(repoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repoPath, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      }
    );
  });
}

/** 本体と各worktreeのHEADを並べた指紋。worktreeの追加・削除でも変わる */
export async function readHeadFingerprint(commonDir: string): Promise<string> {
  const lines = [
    `main:${(await fsp.readFile(path.join(commonDir, "HEAD"), "utf8")).trim()}`,
  ];
  let names: string[] = [];
  try {
    names = (await fsp.readdir(path.join(commonDir, "worktrees"))).sort();
  } catch {
    // worktreeを1つも足していなければ worktrees/ は無い
  }
  for (const name of names) {
    try {
      const head = await fsp.readFile(
        path.join(commonDir, "worktrees", name, "HEAD"),
        "utf8"
      );
      lines.push(`${name}:${head.trim()}`);
    } catch {
      // 作成・削除の途中は HEAD が無いことがある。次の巡回で拾う
    }
  }
  return lines.join("\n");
}

export interface WorktreeHeadWatcherDeps {
  resolveCommonDir?: (repoPath: string) => Promise<string>;
  readFingerprint?: (commonDir: string) => Promise<string>;
}

export class WorktreeHeadWatcher {
  /** 見ているリポジトリと、その共通のgitディレクトリ。まだ解決していなければ null */
  private readonly commonDirOf = new Map<string, string | null>();
  /** リポジトリごとの最後の指紋。まだ読んでいなければ無い */
  private readonly fingerprintOf = new Map<string, string>();
  private readonly resolveCommonDir: (repoPath: string) => Promise<string>;
  private readonly readFingerprint: (commonDir: string) => Promise<string>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly onChange: (repoPath: string) => void,
    deps: WorktreeHeadWatcherDeps = {}
  ) {
    this.resolveCommonDir = deps.resolveCommonDir ?? resolveGitCommonDir;
    this.readFingerprint = deps.readFingerprint ?? readHeadFingerprint;
  }

  /** 見る対象に加える。既に見ていれば何もしない */
  watch(repoPath: string): void {
    if (this.commonDirOf.has(repoPath)) return;
    this.commonDirOf.set(repoPath, null);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.check(),
      WORKTREE_HEAD_INTERVAL_MS
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 全リポジトリを1巡読む。前の巡回が終わっていなければ何もしない */
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const repoPath of [...this.commonDirOf.keys()]) {
        const fingerprint = await this.read(repoPath);
        if (fingerprint === null) {
          this.commonDirOf.delete(repoPath);
          this.fingerprintOf.delete(repoPath);
          continue;
        }
        const previous = this.fingerprintOf.get(repoPath);
        this.fingerprintOf.set(repoPath, fingerprint);
        if (previous !== undefined && fingerprint !== previous) {
          this.onChange(repoPath);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async read(repoPath: string): Promise<string | null> {
    try {
      let commonDir = this.commonDirOf.get(repoPath) ?? null;
      if (!commonDir) {
        commonDir = await this.resolveCommonDir(repoPath);
        this.commonDirOf.set(repoPath, commonDir);
      }
      return await this.readFingerprint(commonDir);
    } catch {
      return null;
    }
  }
}
