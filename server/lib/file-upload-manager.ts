/**
 * File Upload Manager
 *
 * 任意ファイル（画像/PDF/テキスト系）のアップロード保存・管理を行うモジュール。
 * セッションごとにディレクトリを分けて保存し、24時間経過後に自動削除する。
 *
 * 注意: 既存の server/lib/file-manager.ts（ファイルビューワー用）とは別モジュール。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SaveFileResult {
  path: string;
  filename: string;
  originalFilename?: string;
}

export type FileUploadManagerErrorCode =
  | "INVALID_MIME_TYPE"
  | "FILE_TOO_LARGE"
  | "INVALID_SESSION_ID"
  | "INVALID_FILENAME"
  | "SAVE_FAILED"
  | "CLEANUP_FAILED";

export class FileUploadManagerError extends Error {
  constructor(
    message: string,
    public readonly code: FileUploadManagerErrorCode
  ) {
    super(message);
    this.name = "FileUploadManagerError";
  }
}

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "js",
  "text/x-typescript": "ts",
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
};

/**
 * originalFilename から安全に取れる拡張子のホワイトリスト
 * ブラウザが非標準MIME（Excel由来のCSV、空MIME、application/octet-stream 等）を返すケースを救済する
 */
const SAFE_EXTENSION_WHITELIST = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "txt",
  "md",
  "mdx",
  "csv",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const BASE_DIR = "/tmp/ark-files";

export class FileUploadManager {
  private readonly baseDir: string;

  constructor(baseDir: string = BASE_DIR) {
    this.baseDir = path.resolve(baseDir);
  }

  async saveFile(
    sessionId: string,
    base64Data: string,
    mimeType: string,
    originalFilename?: string
  ): Promise<SaveFileResult> {
    const sanitizedSessionId = this.sanitizeSessionId(sessionId);
    if (!sanitizedSessionId) {
      throw new FileUploadManagerError(
        "無効なセッションIDです",
        "INVALID_SESSION_ID"
      );
    }

    const extension = this.resolveExtension(mimeType, originalFilename);
    if (!extension) {
      throw new FileUploadManagerError(
        `許可されていないファイル形式です: ${mimeType}`,
        "INVALID_MIME_TYPE"
      );
    }

    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length > MAX_FILE_SIZE) {
      throw new FileUploadManagerError(
        `ファイルサイズが上限（10MB）を超えています: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
        "FILE_TOO_LARGE"
      );
    }

    const filename = this.generateFilename(extension);
    const sessionDir = path.join(this.baseDir, sanitizedSessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, filename);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (error) {
      throw new FileUploadManagerError(
        `ファイルの保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        "SAVE_FAILED"
      );
    }

    return { path: filePath, filename, originalFilename };
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    try {
      const exists = await this.directoryExists(this.baseDir);
      if (!exists) return 0;

      const sessionDirs = await fs.readdir(this.baseDir, {
        withFileTypes: true,
      });

      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;

        const sessionPath = path.join(this.baseDir, sessionDir.name);
        const files = await fs.readdir(sessionPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile()) continue;
          const filePath = path.join(sessionPath, file.name);
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > FILE_EXPIRY_MS) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        }

        const remaining = await fs.readdir(sessionPath);
        if (remaining.length === 0) {
          await fs.rmdir(sessionPath);
        }
      }
      return deletedCount;
    } catch (error) {
      throw new FileUploadManagerError(
        `クリーンアップに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        "CLEANUP_FAILED"
      );
    }
  }

  private sanitizeSessionId(sessionId: string): string | null {
    // サニタイズ方式（危険文字を除去）では "." や ".." が空文字/そのままベースディレクトリ直下を指す
    // 危険があるため、検証方式（不正な入力は null を返す）に変更している
    if (typeof sessionId !== "string") return null;
    const trimmed = sessionId.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > 256 ||
      trimmed === "." ||
      trimmed === ".." ||
      /[/\\<>:"|?*\x00-\x1f]/.test(trimmed)
    ) {
      return null;
    }
    return trimmed;
  }

  private resolveExtension(
    mimeType: string,
    originalFilename?: string
  ): string | null {
    // 1) MIMEホワイトリストを優先
    const fromMime = MIME_TO_EXTENSION[mimeType];
    if (fromMime) return fromMime;

    // 2) originalFilename の拡張子が安全リストに含まれていればそれを採用
    //    ブラウザが非標準MIMEを返すケース（Excel→CSV、空MIME、octet-stream等）を救済する
    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase().slice(1);
      if (ext && SAFE_EXTENSION_WHITELIST.has(ext)) {
        return ext;
      }
    }
    return null;
  }

  private generateFilename(extension: string): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString("hex");
    return `${timestamp}-${random}.${extension}`;
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}

export const fileUploadManager = new FileUploadManager();
