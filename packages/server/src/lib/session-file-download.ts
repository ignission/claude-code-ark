/**
 * 生成ファイル配信用の transcript allowlist ヘルパー。
 *
 * セッション transcript に実際に出現した絶対パスだけを配信許可する。出所は
 * assistant の text 出力と tool_result(tool 出力)に限定し、user 入力は除外する
 * ([[collectGeneratedTextsFromTranscript]])。
 *
 * 【受容済みリスク (documented)】
 * これは「生成ファイルの証明」ではなく「transcript に表示された process-readable な
 * パス」への配信権限であり、worktree 等の trusted root には限定していない。これは
 * spec の確定設計である (screenshot は /home や /tmp に出るため worktree 限定は使えず、
 * 「transcript に出たパスだけ許可」を選択した)。
 *
 * 脅威モデル上これは権限昇格にならない: 本エンドポイントへ到達できる主体 (local /
 * Quick Tunnel トークン / Named Tunnel 認証) は、いずれも既に Claude セッションを
 * 操作でき = 任意コマンド実行・任意ファイル読取が可能なため、本配信は追加権限を
 * 与えない。将来 Claude を操作できない read-only 閲覧モードを追加する場合は、ここを
 * trusted root 限定へ見直すこと。
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

interface TranscriptBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

interface TranscriptRecord {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function pushToolResultText(texts: string[], content: unknown): void {
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as TranscriptBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  }
}

/**
 * transcript(JSONL)から配信 allowlist の根拠テキストだけを取り出す。
 *
 * 出所を区別せず全文からパス抽出すると、user 入力に任意パスを書かせるだけで
 * プロセス権限で読める任意ファイルを配信できてしまう。そのため
 * 「assistant の text 出力」と「tool_result(= tool 出力)」に限定する。
 * user 入力(string/text ブロック)と assistant の tool_use input は対象外。
 */
export function collectGeneratedTextsFromTranscript(jsonl: string): string[] {
  const texts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (line === "") continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      // 書き込み途中で切れた行など。次の行へ
      continue;
    }
    const content = rec.message?.content;
    if (rec.type === "assistant" && rec.message?.role === "assistant") {
      if (Array.isArray(content)) {
        for (const block of content as TranscriptBlock[]) {
          if (block?.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
      }
    } else if (rec.type === "user" && rec.message?.role === "user") {
      // user レコードでも tool_result は tool 出力なので拾う。
      // string content / text ブロックは user 入力なので除外する。
      if (Array.isArray(content)) {
        for (const block of content as TranscriptBlock[]) {
          if (block?.type === "tool_result") {
            pushToolResultText(texts, block.content);
          }
        }
      }
    }
  }
  return texts;
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
    // worktree 紐付けの検証: ディレクトリ名(encodeProjectDir)で既に紐付くが、
    // encode 衝突(例 /a/b と /a.b は同一ディレクトリ名)対策として cwd も照合する。
    // cwd を読めない transcript は worktree 対応を確証できないため除外する(assertive)。
    // 照合は canonical path ではなく transcript の cwd 文字列との完全一致(意図的)。
    // worktreePath は呼び出し元(orchestrator)で一貫した文字列を使うため表記ゆれは無い。
    const cwd = readTranscriptCwd(filePath);
    if (cwd !== worktreePath) continue;
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
  const paths = [
    ...buildFileAllowlistFromTexts(collectGeneratedTextsFromTranscript(text)),
  ];
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
