/**
 * Image Manager Module
 *
 * 画像ファイルの保存・管理機能を提供するモジュール。
 * セッションごとにディレクトリを分けて画像を保存し、
 * 古い画像の自動クリーンアップ機能を持つ。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** 保存結果の型 */
interface SaveImageResult {
  /** 保存されたファイルの絶対パス */
  path: string;
  /** 保存されたファイル名 */
  filename: string;
}

/** 画像保存時のエラー */
export class ImageManagerError extends Error {
  constructor(
    message: string,
    public readonly code: ImageManagerErrorCode
  ) {
    super(message);
    this.name = "ImageManagerError";
  }
}

/** エラーコードの種類 */
export type ImageManagerErrorCode =
  | "INVALID_MIME_TYPE"
  | "FILE_TOO_LARGE"
  | "INVALID_SESSION_ID"
  | "SAVE_FAILED"
  | "CLEANUP_FAILED";

/** 許可されるMIMEタイプ */
const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** MIMEタイプと拡張子のマッピング */
const MIME_TO_EXTENSION: Record<AllowedMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** ファイルサイズ上限: 10MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 画像の有効期限: 24時間（ミリ秒） */
const IMAGE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** 画像保存のベースディレクトリ（グローバルな一時ディレクトリ） */
const BASE_DIR = "/tmp/ark-images";

export class ImageManager {
  private readonly baseDir: string;

  constructor(baseDir: string = BASE_DIR) {
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * 画像を保存する
   *
   * @param sessionId - セッションID
   * @param base64Data - Base64エンコードされた画像データ
   * @param mimeType - 画像のMIMEタイプ
   * @returns 保存されたファイルのパスとファイル名
   * @throws {ImageManagerError} バリデーションエラーまたは保存エラー
   */
  async saveImage(
    sessionId: string,
    base64Data: string,
    mimeType: string
  ): Promise<SaveImageResult> {
    // セッションIDのバリデーション
    const sanitizedSessionId = this.sanitizeSessionId(sessionId);
    if (!sanitizedSessionId) {
      throw new ImageManagerError(
        "無効なセッションIDです",
        "INVALID_SESSION_ID"
      );
    }

    // MIMEタイプのバリデーション
    if (!this.isAllowedMimeType(mimeType)) {
      throw new ImageManagerError(
        `許可されていないMIMEタイプです: ${mimeType}。許可形式: ${ALLOWED_MIME_TYPES.join(", ")}`,
        "INVALID_MIME_TYPE"
      );
    }

    // Base64データをデコード
    const buffer = Buffer.from(base64Data, "base64");

    // ファイルサイズのバリデーション
    if (buffer.length > MAX_FILE_SIZE) {
      throw new ImageManagerError(
        `ファイルサイズが上限（10MB）を超えています: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
        "FILE_TOO_LARGE"
      );
    }

    // ファイル名を生成
    const filename = this.generateFilename(mimeType as AllowedMimeType);

    // ディレクトリを作成
    const sessionDir = path.join(this.baseDir, sanitizedSessionId);
    await this.ensureDirectory(sessionDir);

    // ファイルを保存
    const filePath = path.join(sessionDir, filename);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (error) {
      throw new ImageManagerError(
        `画像の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        "SAVE_FAILED"
      );
    }

    return {
      path: filePath,
      filename,
    };
  }

  /**
   * 24時間経過した画像を削除する
   *
   * @returns 削除されたファイル数
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    try {
      // ベースディレクトリが存在しない場合は何もしない
      const exists = await this.directoryExists(this.baseDir);
      if (!exists) {
        return 0;
      }

      // セッションディレクトリを列挙
      const sessionDirs = await fs.readdir(this.baseDir, {
        withFileTypes: true,
      });

      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) {
          continue;
        }

        const sessionPath = path.join(this.baseDir, sessionDir.name);

        // セッションディレクトリ内のファイルを列挙
        const files = await fs.readdir(sessionPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile()) {
            continue;
          }

          const filePath = path.join(sessionPath, file.name);
          const stat = await fs.stat(filePath);

          // 作成から24時間経過している場合は削除
          if (now - stat.mtimeMs > IMAGE_EXPIRY_MS) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        }

        // 空になったディレクトリを削除
        const remainingFiles = await fs.readdir(sessionPath);
        if (remainingFiles.length === 0) {
          await fs.rmdir(sessionPath);
        }
      }

      return deletedCount;
    } catch (error) {
      throw new ImageManagerError(
        `クリーンアップに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        "CLEANUP_FAILED"
      );
    }
  }

  /**
   * セッションIDをサニタイズする
   * パス区切り文字や危険な文字を除去
   */
  private sanitizeSessionId(sessionId: string): string | null {
    if (!sessionId || typeof sessionId !== "string") {
      return null;
    }

    // 危険な文字を除去: パス区切り、.., 制御文字、特殊文字
    const sanitized = sessionId
      .replace(/[/\\]/g, "") // パス区切り文字
      .replace(/\.\./g, "") // 親ディレクトリ参照
      .replace(/[<>:"|?*\x00-\x1f]/g, "") // Windowsで禁止の文字と制御文字
      .trim();

    // 空になった場合はnullを返す
    if (!sanitized || sanitized.length === 0) {
      return null;
    }

    // 最大長を制限（256文字）
    return sanitized.substring(0, 256);
  }

  /**
   * MIMEタイプが許可されているか確認
   */
  private isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
    return ALLOWED_MIME_TYPES.includes(mimeType as AllowedMimeType);
  }

  /**
   * ユニークなファイル名を生成
   * 形式: {timestamp}-{random}.{ext}
   */
  private generateFilename(mimeType: AllowedMimeType): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString("hex");
    const extension = MIME_TO_EXTENSION[mimeType];
    return `${timestamp}-${random}.${extension}`;
  }

  /**
   * ディレクトリが存在しない場合は作成
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  /**
   * ディレクトリが存在するか確認
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}

// シングルトンインスタンス
export const imageManager = new ImageManager();
