/**
 * クライアント側MIMEチェックは意図的にサーバー側より緩い。
 * 最終的な受理可否はサーバー（server/lib/file-upload-manager.ts）のホワイトリストが決定する。
 * クライアントチェックは「明らかに送っても無駄なファイル」を早期に弾くための事前防御。
 */
const ALLOWED_MIME_PREFIXES = ["image/", "text/"];
const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface UploadValidation {
  ok: boolean;
  reason?: string;
}

export function validateFile(file: File): UploadValidation {
  if (file.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      reason: `${file.name}: 10MBを超えています（${(file.size / 1024 / 1024).toFixed(2)}MB）`,
    };
  }
  const mime = file.type || "application/octet-stream";
  const allowed =
    ALLOWED_MIME_EXACT.has(mime) ||
    ALLOWED_MIME_PREFIXES.some(p => mime.startsWith(p));
  if (!allowed) {
    return {
      ok: false,
      reason: `${file.name}: 未対応の形式です（${mime}）`,
    };
  }
  return { ok: true };
}

export async function fileToBase64(
  file: File
): Promise<{ base64: string; mimeType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(",");
      const mimeType =
        header.match(/data:(.*?);/)?.[1] ||
        file.type ||
        "application/octet-stream";
      resolve({ base64, mimeType, filename: file.name });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
