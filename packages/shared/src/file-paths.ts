/**
 * プレーンテキスト中の生成ファイル絶対パスを検出して断片に分解する純粋ロジック。
 *
 * クライアントのリンク化とサーバの transcript allowlist が同じ判定を使うため、
 * shared に置く。
 */

/** 絶対 POSIX パスらしいトークンを検出する */
const FILE_PATH_RE = /(^|[^\w:/])((?:\/(?!\/)[^\s<>"'`|│]+)+)/g;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
]);

/**
 * パス末尾に付きがちな句読点・閉じ括弧を切り離す。
 * 閉じ括弧は、パス内に対応する開き括弧がある場合のみ残す。
 */
function trimTrailingPunctuation(filePath: string): {
  filePath: string;
  trailing: string;
} {
  let end = filePath.length;
  while (end > 0) {
    const ch = filePath[end - 1];
    if (")]}".includes(ch)) {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const slice = filePath.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (opens >= closes) break;
      end--;
    } else if (".,;:!?".includes(ch)) {
      end--;
    } else {
      break;
    }
  }
  return {
    filePath: filePath.slice(0, end),
    trailing: filePath.slice(end),
  };
}

function getExtension(filePath: string): string | null {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return /^[a-zA-Z0-9]+$/.test(ext) ? ext.toLowerCase() : null;
}

function isDetectableFilePath(filePath: string): boolean {
  return filePath.startsWith("/") && getExtension(filePath) !== null;
}

export type FilePathSegment =
  | { type: "text"; value: string }
  | { type: "file"; value: string };

/** 拡張子で画像ファイルか判定する。 */
export function isImagePath(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

/**
 * テキストを「テキスト断片」と「ファイルパス断片」の列に分解する。
 * 連続するテキストはまとめる。パス末尾の句読点はテキスト側へ送る。
 */
export function splitTextWithFilePaths(text: string): FilePathSegment[] {
  const segments: FilePathSegment[] = [];
  let lastIndex = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.type === "text") last.value += value;
    else segments.push({ type: "text", value });
  };

  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FILE_PATH_RE.exec(text);
  while (m !== null) {
    const prefix = m[1] ?? "";
    const rawPath = m[2] ?? "";
    const pathStart = m.index + prefix.length;
    const { filePath, trailing } = trimTrailingPunctuation(rawPath);
    if (isDetectableFilePath(filePath)) {
      pushText(text.slice(lastIndex, pathStart));
      segments.push({ type: "file", value: filePath });
      if (trailing) pushText(trailing);
    } else {
      pushText(text.slice(lastIndex, m.index + m[0].length));
    }
    lastIndex = m.index + m[0].length;
    m = FILE_PATH_RE.exec(text);
  }
  pushText(text.slice(lastIndex));
  return segments;
}

/** テキスト中の検出対象ファイルパスだけを抽出する。 */
export function extractFilePaths(text: string): string[] {
  return splitTextWithFilePaths(text)
    .filter(seg => seg.type === "file")
    .map(seg => seg.value);
}
