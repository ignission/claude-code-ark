import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

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
    if (!realResolved.startsWith("/tmp/")) {
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

export interface FileReadResult {
  filePath: string;
  content: string;
  mimeType: string;
  size: number;
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

  const mimeType = detectMimeType(filePath);

  if (!isTextMimeType(mimeType)) {
    // 画像ファイルはBase64エンコードしてdata URLで返す
    if (mimeType.startsWith("image/")) {
      const buffer = await readFile(safePath);
      const base64 = buffer.toString("base64");
      return {
        filePath,
        content: `data:${mimeType};base64,${base64}`,
        mimeType,
        size: fileStat.size,
      };
    }
    return {
      filePath,
      content: "",
      mimeType,
      size: fileStat.size,
    };
  }

  const content = await readFile(safePath, "utf-8");
  return {
    filePath,
    content,
    mimeType,
    size: fileStat.size,
  };
}
