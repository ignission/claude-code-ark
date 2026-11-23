/**
 * ボードの図を画像としてクリップボードへ書く。
 *
 * 画像は図の中の層 (diagram-sketch-layer.ts) が作り、port 経由で返す。返るまで待ってから
 * 書くと、Safari はクリックの操作の扱いが切れたとして拒む。そこで押したその場で
 * `ClipboardItem` に「あとで画像になる Promise」を渡して書き始める。
 *
 * navigator.clipboard は http のアクセスでは無い。書けないときは PNG を保存させる。
 */

const PNG_PREFIX = "data:image/png;base64,";

/** id は親がコピーを頼んだときに付けた番号。層は同じ番号を付けて返す */
export type DiagramCopyMessage =
  | { kind: "picture"; id: unknown; dataUrl: string }
  | { kind: "error"; id: unknown };

/** 層が返す画像 (ark:diagram-copy) か失敗 (ark:diagram-copy-error) を読む。どちらでもなければ null */
export function readDiagramCopyMessage(
  data: unknown
): DiagramCopyMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, id, dataUrl } = data as {
    type?: unknown;
    id?: unknown;
    dataUrl?: unknown;
  };
  if (type === "ark:diagram-copy-error") return { kind: "error", id };
  if (type !== "ark:diagram-copy") return null;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX)) {
    return { kind: "error", id };
  }
  return { kind: "picture", id, dataUrl };
}

export function pngDataUrlToBlob(dataUrl: string): Blob {
  const binary = atob(dataUrl.slice(PNG_PREFIX.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/** 図のパスから保存するときのファイル名を作る (`a/b.diagram.html` → `b.png`) */
export function diagramImageFileName(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const name = base.replace(/(\.diagram)?\.html?$/i, "");
  return `${name || "board"}.png`;
}

export type CopyImageResult = "copied" | "downloaded" | "failed";

/**
 * 画像をクリップボードへ書く。書けなければ保存させる。
 * クリックの処理から await を挟まずに呼ぶこと (最初の await がクリップボードへの書き込み)
 */
export async function copyImageToClipboard(
  picture: Promise<Blob>,
  fileName: string
): Promise<CopyImageResult> {
  const clipboard = navigator.clipboard;
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof clipboard?.write === "function"
  ) {
    try {
      await clipboard.write([new ClipboardItem({ "image/png": picture })]);
      return "copied";
    } catch {
      // 権限で拒まれたときは保存に回す。画像を作れなかったときは下でも失敗する
    }
  }
  try {
    const blob = await picture;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
