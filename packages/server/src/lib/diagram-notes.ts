/**
 * ボードの付箋。図の隣のファイル `<名前>.notes.json` に持つ。
 *
 * 人はボードの上で付箋を置き、動かし、書く (diagram-notes-layer.ts)。Claude は同じファイルを
 * 普段のファイル編集で読み書きする。「Claudeに渡す」を押すと Ark が定型文を1通送り、
 * Claude は付箋を動かす、枠でくくる、自分の付箋を置く、のどれかで返す。返事はチャットではなく
 * ボードに出る (#598 の「囲んだ文字を会話の入力欄へ引用する」は、やり取りが結局チャットの
 * 文章のままで、ボードである意味が無かった)。
 *
 * 決まり:
 * - **図の HTML には触らない。** 付箋は Ark が持つ別の層で、位置は図の文書の左上からの px。
 *   Claude が図を書き直しても付箋は残る (図の要素には紐付けない)
 * - **使い方はファイル自身に書く** (`about`)。稼働中のセッションは SessionStart の案内を
 *   読み直さないので、定型文とこのファイルだけで Claude が動けるようにする。何も知らない
 *   エージェントに定型文だけを渡し、重なりなく枠にまとめて返せることを確かめてある
 * - **人の操作は、一覧の丸ごとではなく操作の単位で保存する。** Claude の番の間に人が付箋を
 *   動かしても、古い一覧で Claude の結果を潰さない。保存は、いまのファイルを読み、操作を
 *   1つ当て、一時ファイルから rename で置き換える。同じファイルへの保存は直列にする
 * - **Claude の書き損じで付箋を失わない。** JSON として読めないファイルには書かず、
 *   `invalid` を返す (画面は最後に読めた付箋を出し続け、知らせを出す)。形の合わない付箋と枠は
 *   読み飛ばし、その数を返す
 * - **付箋のファイルのパスは、検証済みの図のパスから作る。** クライアントからは受け取らない
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIAGRAM_FRAME_LABEL_MAX,
  DIAGRAM_FRAMES_MAX,
  DIAGRAM_NOTE_COORD_MAX,
  DIAGRAM_NOTE_HEIGHT,
  DIAGRAM_NOTE_TEXT_MAX,
  DIAGRAM_NOTE_WIDTH,
  DIAGRAM_NOTES_MAX,
  type DiagramFrame,
  type DiagramNote,
  type DiagramNoteOp,
  type DiagramNotes,
  type DiagramNotesErrorCode,
} from "@ark/shared";
import { DIAGRAM_DIR, resolveDiagramPath } from "./diagram-path.js";
import { errnoCode } from "./errors.js";

const DIAGRAM_SUFFIX = ".diagram.html";
export const NOTES_SUFFIX = ".notes.json";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 64;
const DEFAULT_VIEW_WIDTH = 900;
const ID_RE = /^[A-Za-z0-9_-]+$/;

export type NotesResult =
  | { ok: true; notes: DiagramNotes; dropped: number }
  | { ok: false; code: DiagramNotesErrorCode };

/** 図の worktree 相対パスから、付箋のファイルの worktree 相対パスを作る */
export function notesRelPathOf(diagramRelPath: string): string {
  return `${diagramRelPath.slice(0, -DIAGRAM_SUFFIX.length)}${NOTES_SUFFIX}`;
}

/** 付箋のファイルの先頭に書く使い方。Claude はこれと定型文だけを手がかりに書き換える */
export function notesAbout(diagramFileName: string): string {
  return (
    `Sticky notes on the Ark board, drawn over ${diagramFileName}. ` +
    "x and y are CSS px from the top-left of the board. " +
    `Each note is ${DIAGRAM_NOTE_WIDTH} wide and about ${DIAGRAM_NOTE_HEIGHT} tall; keep at least 20 px between notes and stay within view.width. ` +
    'Notes with author "human" were written by the user: you may move them (x, y) but must not change their text or delete them. ' +
    'Add your own notes with author "claude" and a new id. ' +
    "frames are labelled dashed boxes drawn behind the notes: {id, label, x, y, w, h}; leave 40 px inside the top of a frame for its label. " +
    "The board redraws as soon as this file is saved, so write valid JSON."
  );
}

function coord(value: unknown, max = DIAGRAM_NOTE_COORD_MAX): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    ID_RE.test(value)
  );
}

/**
 * 付箋のファイルの中身を読む。JSON として読めない、または `notes` が配列でなければ null。
 * 形の合わない付箋と枠は読み飛ばして数える (Claude の小さな書き損じでボード全体を止めない)。
 */
export function parseNotes(
  raw: string
): { notes: DiagramNotes; dropped: number; viewWidth: number } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const file = data as { notes?: unknown; frames?: unknown; view?: unknown };
  if (!Array.isArray(file.notes)) return null;
  const rawFrames = Array.isArray(file.frames) ? file.frames : [];

  let dropped = 0;
  const seen = new Set<string>();
  const notes: DiagramNote[] = [];
  for (const item of file.notes) {
    const note = item as Partial<Record<keyof DiagramNote, unknown>> | null;
    const x = coord(note?.x);
    const y = coord(note?.y);
    if (
      !note ||
      !validId(note.id) ||
      seen.has(note.id) ||
      typeof note.text !== "string" ||
      x === null ||
      y === null ||
      notes.length >= DIAGRAM_NOTES_MAX
    ) {
      dropped++;
      continue;
    }
    seen.add(note.id);
    notes.push({
      id: note.id,
      // human と書かれたものだけを人の付箋として扱う
      author: note.author === "human" ? "human" : "claude",
      text: note.text.slice(0, DIAGRAM_NOTE_TEXT_MAX),
      x,
      y,
    });
  }

  const frameIds = new Set<string>();
  const frames: DiagramFrame[] = [];
  for (const item of rawFrames) {
    const frame = item as Partial<Record<keyof DiagramFrame, unknown>> | null;
    const x = coord(frame?.x);
    const y = coord(frame?.y);
    const w = coord(frame?.w);
    const h = coord(frame?.h);
    if (
      !frame ||
      !validId(frame.id) ||
      frameIds.has(frame.id) ||
      x === null ||
      y === null ||
      !w ||
      !h ||
      frames.length >= DIAGRAM_FRAMES_MAX
    ) {
      dropped++;
      continue;
    }
    frameIds.add(frame.id);
    frames.push({
      id: frame.id,
      label:
        typeof frame.label === "string"
          ? frame.label.slice(0, DIAGRAM_FRAME_LABEL_MAX)
          : "",
      x,
      y,
      w,
      h,
    });
  }

  const width = coord((file.view as { width?: unknown } | null)?.width);
  return {
    notes: { notes, frames },
    dropped,
    viewWidth: width || DEFAULT_VIEW_WIDTH,
  };
}

/** 外から来た操作の形を確かめる。合わなければ null */
export function parseNoteOp(value: unknown): DiagramNoteOp | null {
  if (typeof value !== "object" || value === null) return null;
  const op = value as Record<string, unknown>;
  if (!validId(op.id)) return null;
  if (op.type === "delete") return { type: "delete", id: op.id };
  if (op.type === "text") {
    if (typeof op.text !== "string") return null;
    return {
      type: "text",
      id: op.id,
      text: op.text.slice(0, DIAGRAM_NOTE_TEXT_MAX),
    };
  }
  if (op.type === "add" || op.type === "move") {
    const x = coord(op.x);
    const y = coord(op.y);
    if (x === null || y === null) return null;
    return { type: op.type, id: op.id, x, y };
  }
  return null;
}

/**
 * 付箋に操作を1つ当てる。当てる相手が無い操作 (Claude が消した付箋を動かした、など) は
 * 何もせずに元の付箋を返す。付箋の数が上限なら "limit"。
 * 文を書き換えられるのは人の付箋だけ。動かす、消すは、Claude の付箋にもできる。
 */
export function applyNoteOp(
  notes: DiagramNotes,
  op: DiagramNoteOp
): DiagramNotes | "limit" {
  const index = notes.notes.findIndex(note => note.id === op.id);
  if (op.type === "add") {
    if (index >= 0) return notes;
    if (notes.notes.length >= DIAGRAM_NOTES_MAX) return "limit";
    return {
      ...notes,
      notes: [
        ...notes.notes,
        { id: op.id, author: "human", text: "", x: op.x, y: op.y },
      ],
    };
  }
  const target = notes.notes[index];
  if (!target) return notes;
  if (op.type === "delete") {
    return { ...notes, notes: notes.notes.filter(note => note.id !== op.id) };
  }
  if (op.type === "text" && target.author !== "human") return notes;
  const next =
    op.type === "move"
      ? { ...target, x: op.x, y: op.y }
      : { ...target, text: op.text };
  return {
    ...notes,
    notes: notes.notes.map(note => (note.id === op.id ? next : note)),
  };
}

export function serializeNotes(
  notes: DiagramNotes,
  diagramFileName: string,
  viewWidth: number
): string {
  return `${JSON.stringify(
    {
      about: notesAbout(diagramFileName),
      view: { width: viewWidth },
      notes: notes.notes,
      frames: notes.frames,
    },
    null,
    2
  )}\n`;
}

type Located =
  | { ok: true; absPath: string; diagramFileName: string }
  | { ok: false; code: "forbidden" | "io" | "missing" };

/**
 * 付箋のファイルの場所を決める。図のパスの検証 (DIAGRAM_DIR の中に収まること) に加えて、
 * 置き場所のディレクトリの実体が worktree の DIAGRAM_DIR の中にあることを確かめる
 * (ディレクトリがシンボリックリンクで外を指していたら、外のファイルを読み書きしてしまう)。
 * ディレクトリがまだ無いときは `missing`。
 */
async function locate(
  worktreeReal: string,
  diagramRelPath: string
): Promise<Located> {
  const resolved = resolveDiagramPath(worktreeReal, diagramRelPath);
  if (!resolved.ok) return { ok: false, code: "forbidden" };
  const absPath = notesRelPathOf(resolved.absPath);
  const base = path.join(worktreeReal, DIAGRAM_DIR);
  try {
    const dirReal = await realpath(path.dirname(absPath));
    if (dirReal !== base && !dirReal.startsWith(base + path.sep)) {
      return { ok: false, code: "forbidden" };
    }
  } catch (error) {
    return {
      ok: false,
      code: errnoCode(error) === "ENOENT" ? "missing" : "io",
    };
  }
  return {
    ok: true,
    absPath,
    diagramFileName: path.basename(resolved.absPath),
  };
}

type RawRead =
  | { kind: "missing" }
  | { kind: "raw"; raw: string }
  | { kind: "error"; code: "forbidden" | "io" };

/** シンボリックリンクをたどらずに読む。通常のファイルでなければ読まない */
async function readRaw(absPath: string): Promise<RawRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      absPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return { kind: "error", code: "forbidden" };
    }
    return { kind: "raw", raw: await handle.readFile("utf-8") };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    // O_NOFOLLOW でシンボリックリンクを開こうとすると ELOOP になる
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM") {
      return { kind: "error", code: "forbidden" };
    }
    return { kind: "error", code: "io" };
  } finally {
    await handle?.close();
  }
}

const EMPTY: DiagramNotes = { notes: [], frames: [] };

/** 付箋を読む。付箋のファイルがまだ無ければ空で返す */
export async function readDiagramNotes(
  worktreeReal: string,
  diagramRelPath: string
): Promise<NotesResult> {
  const located = await locate(worktreeReal, diagramRelPath);
  if (!located.ok) {
    // 置き場所のディレクトリがまだ無い = 付箋もまだ無い
    return located.code === "missing"
      ? { ok: true, notes: EMPTY, dropped: 0 }
      : { ok: false, code: located.code };
  }
  const read = await readRaw(located.absPath);
  if (read.kind === "missing") return { ok: true, notes: EMPTY, dropped: 0 };
  if (read.kind === "error") return { ok: false, code: read.code };
  const parsed = parseNotes(read.raw);
  if (!parsed) return { ok: false, code: "invalid" };
  return { ok: true, notes: parsed.notes, dropped: parsed.dropped };
}

/** 同じファイルへの保存を直列にする (読む、当てる、置き換える、の間に別の保存を挟ませない) */
const writeQueues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(key, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    });
  return next;
}

/** 付箋に操作を1つ当てて保存し、保存後の付箋を返す */
export async function applyDiagramNoteOp(
  worktreeReal: string,
  diagramRelPath: string,
  op: DiagramNoteOp,
  viewWidth?: number
): Promise<NotesResult> {
  const located = await locate(worktreeReal, diagramRelPath);
  if (!located.ok) {
    return {
      ok: false,
      code: located.code === "missing" ? "io" : located.code,
    };
  }
  return serialize(located.absPath, async () => {
    const read = await readRaw(located.absPath);
    if (read.kind === "error") return { ok: false, code: read.code };
    let current = { notes: EMPTY, dropped: 0, viewWidth: DEFAULT_VIEW_WIDTH };
    if (read.kind === "raw") {
      const parsed = parseNotes(read.raw);
      if (!parsed) return { ok: false, code: "invalid" };
      current = parsed;
    }
    const next = applyNoteOp(current.notes, op);
    if (next === "limit") return { ok: false, code: "limit" };
    if (next === current.notes) {
      return { ok: true, notes: next, dropped: current.dropped };
    }
    const width = coord(viewWidth) || current.viewWidth;
    const tmp = path.join(
      path.dirname(located.absPath),
      `.${path.basename(located.absPath)}.ark-tmp-${process.pid}-${Date.now()}`
    );
    try {
      await writeFile(
        tmp,
        serializeNotes(next, located.diagramFileName, width),
        { flag: "wx", mode: 0o644 }
      );
      // rename は、置き換え先がシンボリックリンクでもリンクそのものを置き換える
      await rename(tmp, located.absPath);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return { ok: false, code: "io" };
    }
    return { ok: true, notes: next, dropped: current.dropped };
  });
}

/** 図を消したときに、付箋のファイルも消す。無ければ何もしない */
export async function removeDiagramNotes(
  worktreeReal: string,
  diagramRelPath: string
): Promise<void> {
  const located = await locate(worktreeReal, diagramRelPath);
  if (!located.ok) return;
  try {
    // シンボリックリンクなら、リンクそのものを消す (指す先には触らない)
    const stat = await lstat(located.absPath);
    if (stat.isFile() || stat.isSymbolicLink()) await rm(located.absPath);
  } catch {
    // 無い、または消せない。図そのものは消えているので、ここでは知らせない
  }
}

/** 図の絶対パスから、監視する付箋のファイルの絶対パスを作る */
export function notesAbsPathOf(diagramAbsPath: string): string {
  return notesRelPathOf(diagramAbsPath);
}
