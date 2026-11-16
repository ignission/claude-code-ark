/**
 * ボードの図の上に描いた手書きを、会話の入力欄へ添付するための部品。
 *
 * 画像は図の中の層 (diagram-sketch-layer.ts) が作って送ってくる。ここでは受け取った
 * メッセージを確かめ、会話へのファイル添付と同じ経路 (`file-upload:upload`) で保存する。
 * 保存先のパスは `@パス` の形で入力欄に入れる (SplitChatPane の添付と同じ書き方)。
 */

import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import type { Socket } from "socket.io-client";
import { m } from "@/lib/i18n";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const PNG_PREFIX = "data:image/png;base64,";
/** 受け取る画像の長さの上限 (base64 の文字数)。サーバーの上限 20MB より小さくしておく */
const MAX_DATA_URL_LENGTH = 16_000_000;
const UPLOAD_TIMEOUT_MS = 30_000;

export type DiagramSketchMessage =
  | { kind: "picture"; base64: string }
  | { kind: "error" };

/** 図の中身は信頼しない。PNG の data URL と、失敗の知らせだけを読む */
export function readDiagramSketchMessage(
  data: unknown
): DiagramSketchMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, dataUrl } = data as { type?: unknown; dataUrl?: unknown };
  if (type === "ark:diagram-sketch-error") return { kind: "error" };
  if (type !== "ark:diagram-sketch") return null;
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith(PNG_PREFIX) ||
    dataUrl.length > MAX_DATA_URL_LENGTH
  ) {
    return { kind: "error" };
  }
  const base64 = dataUrl.slice(PNG_PREFIX.length);
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) {
    return { kind: "error" };
  }
  return { kind: "picture", base64 };
}

/** 手書きの線。文書の座標の点と太さの並び */
export type SketchStroke = Array<{ x: number; y: number; w: number }>;

const MAX_STROKES = 500;
const MAX_POINTS = 60_000;

/**
 * 層が知らせてくる今の線を読む。親は線を覚えておき、図が読み直されたら層へ返す。
 * 図の中身は信頼しないので、数だけを通し、量に上限を置く (超えたら覚えない)
 */
export function readDiagramSketchStrokesMessage(
  data: unknown
): SketchStroke[] | null {
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "ark:diagram-sketch-strokes"
  ) {
    return null;
  }
  const { strokes } = data as { strokes?: unknown };
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) return [];
  const result: SketchStroke[] = [];
  let points = 0;
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) continue;
    const clean: SketchStroke = [];
    for (const point of stroke) {
      const { x, y, w } = (point ?? {}) as Record<string, unknown>;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof w === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(w)
      ) {
        clean.push({ x, y, w });
      }
    }
    points += clean.length;
    if (points > MAX_POINTS) return [];
    if (clean.length > 0) result.push(clean);
  }
  return result;
}

/** 層のボタンに出す文言。図の中の層は言語を知らないので、親から渡す */
export function sketchLabels(): Record<string, string> {
  const { draw, eraser, undo, clear, send, sending, close } = m.board.sketch;
  return { draw, eraser, undo, clear, send, sending, close };
}

/** 入力欄に入れる文。画像を `@パス` で指し、どの図への書き込みかを添える */
export function buildSketchDraft(imagePath: string, relPath: string): string {
  return `@${imagePath} ${m.board.sketch.draft(relPath)}`;
}

/** 画像を保存して、保存先のパスを返す */
export function uploadSketch(
  socket: TypedSocket,
  sessionId: string,
  base64: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // 切れている間の emit は溜まるだけで、時間切れまで待たせることになる
    if (!socket.connected) {
      reject(new Error(m.session.socket.disconnected));
      return;
    }
    const requestId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("file-upload:uploaded", onUploaded);
      socket.off("file-upload:error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(m.session.socket.uploadTimeout));
    }, UPLOAD_TIMEOUT_MS);
    const onUploaded = (result: { requestId: string; path: string }) => {
      if (result.requestId !== requestId) return;
      cleanup();
      resolve(result.path);
    };
    const onError = (error: { requestId: string; message: string }) => {
      if (error.requestId !== requestId) return;
      cleanup();
      reject(new Error(error.message));
    };
    socket.on("file-upload:uploaded", onUploaded);
    socket.on("file-upload:error", onError);
    socket.emit("file-upload:upload", {
      sessionId,
      base64Data: base64,
      mimeType: "image/png",
      originalFilename: "board-sketch.png",
      requestId,
    });
  });
}
