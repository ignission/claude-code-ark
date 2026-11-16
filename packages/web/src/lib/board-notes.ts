import type { BridgeSessionStatus, DiagramNoteOp } from "@ark/shared";
import { m } from "@/lib/i18n";

const NOTE_OP_TYPES = new Set(["add", "move", "text", "delete"]);
const MAX_ID_LENGTH = 64;

/**
 * 付箋の層 (diagram-notes-layer.ts) から届いた操作を読む。
 *
 * 親とやり取りする port は図自身のスクリプトも拾えるので、ここで形を確かめる (位置や文の
 * 上限は、保存するサーバーがもう一度確かめる)。この経路で起こせるのは付箋の保存だけで、
 * Claude への送信は起こせない。送信は、人が親の画面のボタンを押したときだけ行う。
 */
export function readDiagramNoteOpMessage(
  data: unknown
): { op: DiagramNoteOp; viewWidth?: number } | null {
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "ark:diagram-note-op"
  ) {
    return null;
  }
  const { op, viewWidth } = data as { op?: unknown; viewWidth?: unknown };
  if (typeof op !== "object" || op === null) return null;
  const { type, id } = op as { type?: unknown; id?: unknown };
  if (typeof type !== "string" || !NOTE_OP_TYPES.has(type)) return null;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) {
    return null;
  }
  return {
    op: op as DiagramNoteOp,
    ...(typeof viewWidth === "number" && Number.isFinite(viewWidth)
      ? { viewWidth }
      : {}),
  };
}

/** 図のパスから、付箋のファイルのパスを作る (サーバーの notesRelPathOf と同じ規則) */
export function notesPathOf(diagramRelPath: string): string {
  return diagramRelPath.replace(/\.diagram\.html$/, ".notes.json");
}

/** 「Claudeに渡す」で送る定型文 */
export function buildHandOffMessage(diagramRelPath: string): string {
  return m.board.notes.handOffMessage(
    notesPathOf(diagramRelPath),
    diagramRelPath
  );
}

/**
 * Claude が手すきか。作業中や確認待ちの間は渡さない。
 * 送信は tmux へ文と Enter を打ち込むので、確認待ちの間に送ると Enter が選択肢に当たる。
 */
export function isClaudeFree(status: BridgeSessionStatus | undefined): boolean {
  return status === undefined || status === "IDLE" || status === "READY";
}

/** 白紙のボードの名前。作った日時を入れて、一覧で見分けられるようにする */
export function blankBoardName(now: Date): string {
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  return m.board.notes.blankName(now.getMonth() + 1, now.getDate(), time);
}
