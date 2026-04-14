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
    if (!sessionId || typeof sessionId !== "string") return null;
    const sanitized = sessionId
      .replace(/[/\\]/g, "")
      .replace(/\.\./g, "")
      .replace(/[<>:"|?*\x00-\x1f]/g, "")
      .trim();
    if (!sanitized || sanitized.length === 0) return null;
    return sanitized.substring(0, 256);
  }

  private resolveExtension(
    mimeType: string,
    originalFilename?: string
  ): string | null {
    const fromMime = MIME_TO_EXTENSION[mimeType];
    if (fromMime) return fromMime;

    if (mimeType.startsWith("text/") && originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase().slice(1);
      if (ext && /^[a-z0-9]{1,8}$/.test(ext)) {
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
