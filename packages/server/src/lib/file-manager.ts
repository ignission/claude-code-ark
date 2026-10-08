import { execFile } from "node:child_process";
import {
  chmod,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
/** 編集 (書き込み) できる上限サイズ */
export const MAX_EDITABLE_SIZE = 2 * 1024 * 1024;
/** 一覧で返す最大件数 */
const MAX_DIR_ENTRIES = 2000;
/** テキスト判定のために先頭から見るバイト数 */
const TEXT_SNIFF_BYTES = 8 * 1024;
/** git status の結果をキャッシュする時間 */
const GIT_STATUS_TTL_MS = 2000;

// 拡張子→MIMEタイプのマッピング
const EXTENSION_MIME_MAP: Record<string, string> = {
  // Markdown
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  // JavaScript/TypeScript
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  // データ
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  // Web
  ".html": "text/html",
  ".css": "text/css",
  ".scss": "text/css",
  // シェル
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  // 設定
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  // ドキュメント
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  // 画像
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // その他コード
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".proto": "text/x-protobuf",
  ".lua": "text/x-lua",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".dart": "text/x-dart",
  ".r": "text/x-r",
  ".php": "text/x-php",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
};

// ファイル名ベースのMIMEマッピング（dotfileや拡張子なしファイル用）
const FILENAME_MIME_MAP: Record<string, string> = {
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  ".editorconfig": "text/plain",
  ".prettierrc": "application/json",
  ".eslintrc": "application/json",
  ".babelrc": "application/json",
  Dockerfile: "text/x-dockerfile",
  Makefile: "text/x-makefile",
  Rakefile: "text/x-ruby",
  Gemfile: "text/x-ruby",
  LICENSE: "text/plain",
  README: "text/plain",
  CHANGELOG: "text/plain",
  "CLAUDE.md": "text/markdown",
};

function detectMimeType(filePath: string): string {
  const basename = path.basename(filePath);
  // ファイル名全体でマッチ（dotfileや拡張子なしファイル用）
  if (FILENAME_MIME_MAP[basename]) {
    return FILENAME_MIME_MAP[basename];
  }
  // 拡張子でマッチ
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "image/svg+xml"
  );
}

async function resolveSafePath(
  worktreePath: string,
  filePath: string
): Promise<string> {
  if (filePath.includes("..")) {
    throw new Error("ファイルへのアクセスが拒否されました");
  }

  // /tmp配下のファイルは直接アクセスを許可
  if (path.isAbsolute(filePath)) {
    const resolved = path.resolve(filePath);
    let realResolved: string;
    try {
      realResolved = await realpath(resolved);
    } catch {
      throw new Error(`ファイルが見つかりません: ${filePath}`);
    }
    // macOSでは realpath("/tmp/...") が "/private/tmp/..." になるため両方チェック
    if (
      !realResolved.startsWith("/tmp/") &&
      !realResolved.startsWith("/private/tmp/")
    ) {
      throw new Error("ファイルへのアクセスが拒否されました");
    }
    return realResolved;
  }

  // worktree内の相対パスは従来通り
  const resolvedWorktree = await realpath(worktreePath);
  const resolved = path.resolve(resolvedWorktree, filePath);

  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    throw new Error(`ファイルが見つかりません: ${filePath}`);
  }

  if (
    !realResolved.startsWith(resolvedWorktree + path.sep) &&
    realResolved !== resolvedWorktree
  ) {
    throw new Error("ファイルへのアクセスが拒否されました");
  }

  return realResolved;
}

/** 検証済みの絶対パスを返す (読み取りと同じ規則。監視用) */
export async function resolveReadablePath(
  worktreePath: string,
  filePath: string
): Promise<string> {
  return resolveSafePath(worktreePath, filePath);
}

export interface FileReadResult {
  filePath: string;
  content: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  /** worktree 内・テキスト・2MB 以下のときだけ true */
  editable: boolean;
}

/** 先頭 8KB に NUL が無ければテキストとみなす */
async function looksLikeText(safePath: string): Promise<boolean> {
  const handle = await open(safePath, "r");
  try {
    const buf = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, TEXT_SNIFF_BYTES, 0);
    return !buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** 拡張子表 + 中身の NUL 判定でテキストとして扱える MIME を返す (読み書き共通) */
async function detectTextAwareMime(
  safePath: string,
  filePath: string
): Promise<string> {
  const mimeType = detectMimeType(filePath);
  // 拡張子表に無いファイル (.gitattributes 等) は中身を見てテキストなら開く
  if (
    mimeType === "application/octet-stream" &&
    (await looksLikeText(safePath))
  )
    return "text/plain";
  return mimeType;
}

/** safePath が worktree の .git 自体か配下か */
async function isInsideGitDir(
  worktreePath: string,
  safePath: string
): Promise<boolean> {
  const gitDir = path.join(await realpath(worktreePath), ".git");
  return safePath === gitDir || safePath.startsWith(gitDir + path.sep);
}

export async function readFileFromWorktree(
  worktreePath: string,
  filePath: string
): Promise<FileReadResult> {
  const safePath = await resolveSafePath(worktreePath, filePath);
  const fileStat = await stat(safePath);

  if (!fileStat.isFile()) {
    throw new Error(`ファイルではありません: ${filePath}`);
  }

  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(
      `ファイルサイズが上限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています: ${fileStat.size} bytes`
    );
  }

  const mimeType = await detectTextAwareMime(safePath, filePath);

  const base = {
    filePath,
    mimeType,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };

  if (!isTextMimeType(mimeType)) {
    // 画像ファイルはBase64エンコードしてdata URLで返す
    if (mimeType.startsWith("image/")) {
      const buffer = await readFile(safePath);
      const base64 = buffer.toString("base64");
      return {
        ...base,
        content: `data:${mimeType};base64,${base64}`,
        editable: false,
      };
    }
    return { ...base, content: "", editable: false };
  }

  const content = await readFile(safePath, "utf-8");
  return {
    ...base,
    content,
    editable:
      !path.isAbsolute(filePath) &&
      fileStat.size <= MAX_EDITABLE_SIZE &&
      !(await isInsideGitDir(worktreePath, safePath)),
  };
}

export type FileWriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; code: "conflict"; error: string; mtimeMs: number }
  | { ok: false; code: "error"; error: string };

/**
 * worktree 内の既存ファイルを書き換える。
 * 絶対パス・.git 配下・ディレクトリ・2MB 超は拒否し、例外は投げない。
 */
export async function writeFileToWorktree(
  worktreePath: string,
  filePath: string,
  content: string,
  expectedMtimeMs: number,
  force = false
): Promise<FileWriteResult> {
  let tmpPath: string | null = null;
  try {
    if (path.isAbsolute(filePath)) {
      return {
        ok: false,
        code: "error",
        error: "書き込めるのは worktree 内のファイルだけです",
      };
    }
    const safePath = await resolveSafePath(worktreePath, filePath);
    if (await isInsideGitDir(worktreePath, safePath)) {
      return { ok: false, code: "error", error: ".git 配下には書き込めません" };
    }

    const st = await stat(safePath);
    if (!st.isFile()) {
      return {
        ok: false,
        code: "error",
        error: `ファイルではありません: ${filePath}`,
      };
    }
    if (!force && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
      return {
        ok: false,
        code: "conflict",
        error: "ファイルが読み込み後に変更されています",
        mtimeMs: st.mtimeMs,
      };
    }
    // 読み取り側の editable と同じ判定で、テキスト以外には書かない
    if (!isTextMimeType(await detectTextAwareMime(safePath, filePath))) {
      return {
        ok: false,
        code: "error",
        error: "テキストファイル以外には書き込めません",
      };
    }
    if (Buffer.byteLength(content) > MAX_EDITABLE_SIZE) {
      return {
        ok: false,
        code: "error",
        error: `サイズが上限（${MAX_EDITABLE_SIZE / 1024 / 1024}MB）を超えています`,
      };
    }

    // 同じディレクトリの一時ファイルへ書いて rename し、書きかけを見せない
    const tmp = path.join(
      path.dirname(safePath),
      `.${path.basename(safePath)}.ark-tmp-${process.pid}-${Date.now()}`
    );
    await writeFile(tmp, content, { mode: st.mode, flag: "wx" });
    // wx が EEXIST で落ちたときに他の書き手の一時ファイルを消さないよう、作れてから覚える
    tmpPath = tmp;
    // 作成時の mode は umask で削られるので明示的に戻す
    await chmod(tmp, st.mode & 0o7777);
    // rename は mtime を変えないので、成功後の stat 失敗で誤報しないよう先に取る
    const { mtimeMs } = await stat(tmp);
    await rename(tmp, safePath);
    tmpPath = null;

    return { ok: true, mtimeMs };
  } catch (err) {
    if (tmpPath) await rm(tmpPath, { force: true }).catch(() => {});
    return {
      ok: false,
      code: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DirEntry {
  name: string;
  type: "dir" | "file";
  gitStatus?: "M" | "A" | "?" | "D";
}

type GitStatusCode = NonNullable<DirEntry["gitStatus"]>;

interface GitStatusSnapshot {
  /** worktree 相対パス (ディレクトリは末尾 "/") → 状態 */
  map: Map<string, GitStatusCode>;
  /** 未追跡ディレクトリ ("dir/" 形式、末尾 "/" 付き) の集合 */
  untrackedDirs: Set<string>;
  /** 変更のあるパスの祖先ディレクトリ (末尾 "/" なし) の集合 */
  changedAncestors: Set<string>;
}

const gitStatusCache = new Map<
  string,
  { at: number; promise: Promise<GitStatusSnapshot> }
>();

function runGit(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    if (input !== undefined) {
      // git が先に終了して EPIPE になっても execFile 側のエラーで扱う
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

function toStatusCode(xy: string): GitStatusCode {
  if (xy.includes("?")) return "?";
  if (xy.includes("A")) return "A";
  if (xy.includes("D")) return "D";
  return "M";
}

async function loadGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const map = new Map<string, GitStatusCode>();
  try {
    const out = await runGit(cwd, ["status", "--porcelain=v1", "-z"]);
    const fields = out.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const rec = fields[i];
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      map.set(rec.slice(3), toStatusCode(xy));
      // rename / copy は元のパスがもう 1 フィールド続く
      if (xy.includes("R") || xy.includes("C")) i++;
    }
  } catch {
    // git が使えないときは状態を付けない
  }
  const untrackedDirs = new Set<string>();
  const changedAncestors = new Set<string>();
  for (const [key, code] of map) {
    if (code === "?" && key.endsWith("/")) untrackedDirs.add(key);
    let i = key.indexOf("/");
    while (i !== -1 && i < key.length - 1) {
      changedAncestors.add(key.slice(0, i));
      i = key.indexOf("/", i + 1);
    }
  }
  return { map, untrackedDirs, changedAncestors };
}

function getGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const cached = gitStatusCache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < GIT_STATUS_TTL_MS) return cached.promise;
  const promise = loadGitStatus(cwd);
  gitStatusCache.set(cwd, { at: now, promise });
  return promise;
}

function statusFor(
  snapshot: GitStatusSnapshot,
  relPath: string,
  isDir: boolean
): GitStatusCode | undefined {
  const { map, untrackedDirs, changedAncestors } = snapshot;
  if (!isDir) {
    const direct = map.get(relPath);
    if (direct) return direct;
  } else {
    const untracked = map.get(`${relPath}/`);
    if (untracked) return untracked;
  }
  // 未追跡ディレクトリの配下は "dir/" 1 件にまとまって出る。祖先を深さ分だけ調べる
  let i = relPath.indexOf("/");
  while (i !== -1) {
    if (untrackedDirs.has(relPath.slice(0, i + 1))) return "?";
    i = relPath.indexOf("/", i + 1);
  }
  if (isDir && changedAncestors.has(relPath)) return "M";
  return undefined;
}

/** git check-ignore で ignore 対象になる名前の集合を返す。失敗したら空 */
async function findIgnored(
  cwd: string,
  relPaths: string[]
): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  try {
    const out = await runGit(
      cwd,
      ["check-ignore", "--stdin", "-z"],
      `${relPaths.join("\0")}\0`
    );
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/** worktree 内のディレクトリを一覧する (.git と gitignore 対象は除く) */
export async function listDirectory(
  worktreePath: string,
  dirPath: string
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  if (path.isAbsolute(dirPath)) {
    throw new Error("ファイルへのアクセスが拒否されました");
  }
  const safeDir = await resolveSafePath(worktreePath, dirPath);
  const realWorktree = await realpath(worktreePath);
  if (!(await stat(safeDir)).isDirectory()) {
    throw new Error(`ディレクトリではありません: ${dirPath}`);
  }
  const relDir = path.relative(realWorktree, safeDir).split(path.sep).join("/");

  const dirents = (await readdir(safeDir, { withFileTypes: true })).filter(
    d => d.name !== ".git"
  );

  const typed = await Promise.all(
    dirents.map(async (d): Promise<DirEntry> => {
      if (d.isDirectory()) return { name: d.name, type: "dir" };
      if (d.isSymbolicLink()) {
        try {
          const st = await stat(path.join(safeDir, d.name));
          return { name: d.name, type: st.isDirectory() ? "dir" : "file" };
        } catch {
          return { name: d.name, type: "file" }; // 壊れたリンク
        }
      }
      return { name: d.name, type: "file" };
    })
  );

  const relOf = (name: string) => (relDir ? `${relDir}/${name}` : name);
  const ignored = await findIgnored(
    realWorktree,
    typed.map(e => relOf(e.name))
  );
  const visible = typed.filter(e => !ignored.has(relOf(e.name)));

  visible.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );
  const truncated = visible.length > MAX_DIR_ENTRIES;
  const entries = visible.slice(0, MAX_DIR_ENTRIES);

  const snapshot = await getGitStatus(realWorktree);
  for (const e of entries) {
    const status = statusFor(snapshot, relOf(e.name), e.type === "dir");
    if (status) e.gitStatus = status;
  }

  return { entries, truncated };
}
