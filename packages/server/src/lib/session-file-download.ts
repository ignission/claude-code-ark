/**
 * 生成ファイル配信用の transcript allowlist ヘルパー。
 *
 * セッション transcript に実際に出現した絶対パスだけを配信許可する。
 */

import fs from "node:fs";
import path from "node:path";
import { extractFilePaths } from "@ark/shared/file-paths";
import { encodeProjectDir, projectsDirFor } from "./claude-projects.js";

const MAX_TRANSCRIPT_CACHE_ENTRIES = 64;

const MIME_BY_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

interface TranscriptCacheEntry {
  paths: string[];
  lastAccess: number;
}

const transcriptFilePathCache = new Map<string, TranscriptCacheEntry>();

function transcriptCacheKey(filePath: string, mtimeMs: number): string {
  return `${filePath}\0${mtimeMs}`;
}

function pruneTranscriptCache(): void {
  if (transcriptFilePathCache.size <= MAX_TRANSCRIPT_CACHE_ENTRIES) return;
  const entries = [...transcriptFilePathCache.entries()].sort(
    (a, b) => a[1].lastAccess - b[1].lastAccess
  );
  for (const [key] of entries.slice(
    0,
    transcriptFilePathCache.size - MAX_TRANSCRIPT_CACHE_ENTRIES
  )) {
    transcriptFilePathCache.delete(key);
  }
}

function readTranscriptCwd(filePath: string): string | null {
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
          if (typeof parsed.cwd === "string") return parsed.cwd;
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

function normalizeAbsolutePosixPath(filePath: string): string | null {
  if (filePath.includes("\0") || !filePath.startsWith("/")) return null;
  return path.normalize(filePath);
}

/** transcript テキスト群から配信許可パス集合を構築する。 */
export function buildFileAllowlistFromTexts(
  texts: Iterable<string>
): Set<string> {
  const allowlist = new Set<string>();
  for (const text of texts) {
    for (const filePath of extractFilePaths(text)) {
      const normalized = normalizeAbsolutePosixPath(filePath);
      if (normalized) allowlist.add(normalized);
    }
  }
  return allowlist;
}

/** リクエストされたパスを照合用に正規化する。 */
export function normalizeRequestedFilePath(filePath: string): string | null {
  return normalizeAbsolutePosixPath(filePath);
}

/** リクエストパスが transcript allowlist に完全一致するか判定する。 */
export function isFilePathAllowed(
  requestedPath: string,
  allowlist: Set<string>
): boolean {
  const normalized = normalizeRequestedFilePath(requestedPath);
  return normalized !== null && allowlist.has(normalized);
}

/**
 * worktree に対応する Claude JSONL transcript 群を列挙する。
 * encode 衝突対策として、cwd が読めた不一致ファイルは除外する。
 */
export async function listTranscriptPathsForWorktree(
  worktreePath: string,
  configDir: string | null | undefined
): Promise<string[]> {
  const dir = path.join(
    projectsDirFor(configDir),
    encodeProjectDir(worktreePath)
  );
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }

  const results: { filePath: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const cwd = readTranscriptCwd(filePath);
    if (cwd !== null && cwd !== worktreePath) continue;
    results.push({ filePath, mtimeMs: st.mtimeMs });
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.map(r => r.filePath);
}

async function readCachedTranscriptPaths(filePath: string): Promise<string[]> {
  const st = await fs.promises.stat(filePath);
  if (!st.isFile()) return [];
  const key = transcriptCacheKey(filePath, st.mtimeMs);
  const cached = transcriptFilePathCache.get(key);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.paths;
  }

  const text = await fs.promises.readFile(filePath, "utf-8");
  const paths = [...buildFileAllowlistFromTexts([text])];
  transcriptFilePathCache.set(key, { paths, lastAccess: Date.now() });
  pruneTranscriptCache();
  return paths;
}

/** transcript ファイル群から配信許可パス集合を構築する。 */
export async function buildAllowlistFromTranscriptFiles(
  transcriptPaths: string[]
): Promise<Set<string>> {
  const allowlist = new Set<string>();
  for (const transcriptPath of transcriptPaths) {
    let paths: string[];
    try {
      paths = await readCachedTranscriptPaths(transcriptPath);
    } catch {
      continue;
    }
    for (const filePath of paths) {
      allowlist.add(filePath);
    }
  }
  return allowlist;
}

/** 拡張子から Content-Type を返す。未知拡張子は download 向けの汎用型にする。 */
export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Content-Disposition attachment 用の filename を安全に組み立てる。 */
export function attachmentDispositionForPath(filePath: string): string {
  const basename = path.basename(filePath) || "download";
  const fallback = basename.replace(/[^\x20-\x7e]|["\\\r\n]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(basename)}`;
}
