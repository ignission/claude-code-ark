/**
 * claude-projects.ts - Claude Code が会話 transcript (JSONL) を永続化する
 * `<configDir>/projects/` ディレクトリに関する純粋ヘルパー群。
 *
 * 通常セッションの JSONL 解決のみを担う。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * セッションごとに CLAUDE_CONFIG_DIR が異なるため、明示的に渡せる形にする。
 * プロファイル未設定なら ~/.claude/projects/ がデフォルト。
 */
export function projectsDirFor(configDir?: string | null): string {
  const base = configDir ?? path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

/**
 * cwd 絶対パスを Claude Code の project ディレクトリ名へエンコードする。
 * Claude Code 本体は **すべての非英数字** を `-` に置換する。
 * 過去に `/` `.` `_` だけ置換する実装で `+` や空白を含むパスを取りこぼした
 * regression があるため、必ず全非英数置換にする。
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * ファイル → 「最初に cwd フィールドを持つ行」の cwd 値キャッシュ。
 * transcript の cwd は不変なので一度読めれば再読不要。
 * (pickLatestJsonl は polling から繰り返し呼ばれるため、毎回のファイル読みを避ける)
 */
const cwdCache = new Map<string, string>();

/** テスト用: cwd キャッシュを破棄する */
export function clearCwdCache(): void {
  cwdCache.clear();
}

/**
 * JSONL ファイル先頭付近 (64KB) から最初の cwd フィールドを読む。
 * 見つからない/読めない場合は null (検証不能)。
 * cwd が確定したときのみキャッシュする (書きかけファイルで null を固定しない)。
 */
function readFileCwd(filePath: string): string | null {
  const cached = cwdCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString("utf-8", 0, n);
      for (const line of head.split("\n")) {
        if (line === "") continue;
        try {
          const parsed = JSON.parse(line) as { cwd?: unknown };
          if (typeof parsed.cwd === "string") {
            cwdCache.set(filePath, parsed.cwd);
            return parsed.cwd;
          }
        } catch {
          // 読み込み境界で切れた行など。次の行へ
        }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * ディレクトリ内で mtime 最新の .jsonl を返す。なければ null。
 *
 * `expectedCwd` を渡すと、各ファイル先頭の cwd フィールドが一致するものを
 * mtime 降順で優先する (encodeProjectDir の衝突対策。例: `/a/b` と `/a.b` は
 * 同じディレクトリ名になる)。優先順位:
 *   1. cwd が expectedCwd に一致するファイル (mtime 降順)
 *   2. cwd が読めないファイル (書きかけ等。検証不能のため fallback 扱い)
 * **既知の不一致ファイルには決してフォールバックしない** (別 worktree の
 * 会話を表示する情報漏えいになるため null を返し、一致ファイルの出現を
 * 呼び出し側の polling に委ねる)。
 */
export function pickLatestJsonl(
  dir: string,
  expectedCwd?: string
): string | null {
  try {
    const entries = fs.readdirSync(dir);
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        candidates.push({ path: full, mtimeMs: st.mtimeMs });
      } catch {
        // stat 失敗 (削除レース等) はスキップ
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (expectedCwd) {
      let unknown: string | null = null;
      for (const c of candidates) {
        const cwd = readFileCwd(c.path);
        if (cwd === expectedCwd) return c.path;
        if (cwd === null && unknown === null) unknown = c.path;
      }
      return unknown;
    }
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}
