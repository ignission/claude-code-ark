/**
 * ブラウザ機能で、canvasの上に重ねて出す部品 (ダイアログ、選択リスト) のフォーカスの決まり。
 *
 * 重ねて出す部品は、リモートのページやほかの視聴者の都合で、利用者の操作と関係なく
 * 現れる。現れたときに、打っている途中の操作を奪わないようにする。
 *
 * - ペインの外 (ほかのパネルのチャット入力欄など) にフォーカスがあるときは、部品が
 *   ダイアログでも選択リストでも、フォーカスを動かさない。部品は描くので、ペインの中を
 *   押せば、そのあとは普通にフォーカスを取る。フォーカスがどこにも無い (文書の本体)
 *   ときは、奪う操作が無いので、外とは数えない
 * - ダイアログは、出たときにフォーカスを取る。置く先は、出る前のフォーカスで決める。
 *   透明のtextarea (リモートのページを操作していた) なら、入力欄か主ボタン。ほかの場所
 *   (URLの入力欄など) なら、ダイアログの枠。枠にあれば、打ちかけのEnterやSpaceは
 *   どのボタンも押さない
 * - 選択リストは、この視聴者がリモートのページを操作した直後 (`LOCAL_INPUT_WINDOW_MS`
 *   以内) に開いたときだけ、フォーカスを取る。それより前から操作していなければ、ほかの
 *   視聴者が開いたものなので、取らない (描きはするので、押せば選べる)
 * - 部品が全部閉じたら、フォーカスを取る前の場所 (URLの入力欄や透明のtextarea) へ戻す。
 *   その要素がもう無いか、取る前にどこにもフォーカスが無かったなら、透明のtextareaへ
 *   置く (続けて打ったキーがページに届く)。フォーカスを取っていないとき、利用者が自分で
 *   ほかの欄へ移っていたとき、ペインが隠れたか切れたときは、動かさない
 *
 * 「リモートのページを操作した」に数えるのは、canvasへの押下とタッチ、透明のtextareaへの
 * キー。URLの入力欄で打っている間に開いた選択リストは、フォーカスを取らない。
 *
 * 出る前のフォーカスは、部品が自分のeffectでフォーカスを動かす直前に読む (`dialogFocusMode`
 * と `selectTakesFocus` を、部品がその時点で呼ぶ)。親のeffectは子のeffectのあとに走るので、
 * 親で読むと、もう部品へ移ったあとになる。
 */

import { type RefObject, useCallback, useEffect, useRef } from "react";

/** リモートのページを操作してから、この時間 (ミリ秒) までに開いた選択リストがフォーカスを取る */
export const LOCAL_INPUT_WINDOW_MS = 1000;

export interface UseBrowserOverlayFocusOptions {
  /** ペインの根の要素。この外にあるフォーカスは奪わない */
  paneRef: RefObject<HTMLElement | null>;
  /** リモートへキーを送る、透明のtextarea */
  inputRef: RefObject<HTMLElement | null>;
  /** 重ねて出す部品を、いま1つでも描いているか */
  shown: boolean;
  /** 閉じたときにフォーカスを戻してよいか (つながっていて、ペインが見えている) */
  canRestore: boolean;
  /** 重ねて出す部品の要素に当たるセレクタ */
  overlaySelector: string;
}

export interface BrowserOverlayFocus {
  /** この視聴者がリモートのページを操作した */
  noteLocalInput: () => void;
  /** ダイアログがフォーカスを置く先。ダイアログが、フォーカスを動かす直前に呼ぶ */
  dialogFocusMode: () => "control" | "panel" | "none";
  /** 選択リストがフォーカスを取ってよいか。リストが、フォーカスを動かす直前に呼ぶ */
  selectTakesFocus: () => boolean;
}

export function useBrowserOverlayFocus({
  paneRef,
  inputRef,
  shown,
  canRestore,
  overlaySelector,
}: UseBrowserOverlayFocusOptions): BrowserOverlayFocus {
  const lastLocalInputRef = useRef(Number.NEGATIVE_INFINITY);
  // 部品がフォーカスを取ったか、取る前にフォーカスがあった要素
  const tookFocusRef = useRef(false);
  const returnToRef = useRef<HTMLElement | null>(null);
  const wasShownRef = useRef(false);

  const noteLocalInput = useCallback(() => {
    lastLocalInputRef.current = performance.now();
  }, []);

  /** フォーカスを取る前の場所を覚える。もう覚えていれば、最初の場所を保つ */
  const remember = useCallback(() => {
    tookFocusRef.current = true;
    if (returnToRef.current) return;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !focused.closest(overlaySelector)
    ) {
      returnToRef.current = focused;
    }
  }, [overlaySelector]);

  /** 打っている途中の要素が、ペインの外にあるか */
  const focusIsOutsidePane = useCallback(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) return false;
    const pane = paneRef.current;
    return pane !== null && !pane.contains(focused);
  }, [paneRef]);

  const dialogFocusMode = useCallback((): "control" | "panel" | "none" => {
    if (focusIsOutsidePane()) return "none";
    // 選択リストに続いて出たときは、リストが取る前の場所で決める
    const before = returnToRef.current ?? document.activeElement;
    remember();
    return before !== null && before === inputRef.current ? "control" : "panel";
  }, [inputRef, remember, focusIsOutsidePane]);

  const selectTakesFocus = useCallback(() => {
    if (focusIsOutsidePane()) return false;
    if (performance.now() - lastLocalInputRef.current > LOCAL_INPUT_WINDOW_MS) {
      return false;
    }
    remember();
    return true;
  }, [remember, focusIsOutsidePane]);

  useEffect(() => {
    if (shown) {
      wasShownRef.current = true;
      return;
    }
    if (!wasShownRef.current) return;
    wasShownRef.current = false;
    const took = tookFocusRef.current;
    const target = returnToRef.current;
    tookFocusRef.current = false;
    returnToRef.current = null;
    if (!took || !canRestore) return;
    // 部品が消えて、フォーカスが文書の本体へ落ちたときだけ戻す
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    const usable =
      target?.isConnected && !(target as HTMLInputElement).disabled;
    (usable ? target : inputRef.current)?.focus({ preventScroll: true });
  }, [shown, canRestore, inputRef]);

  return { noteLocalInput, dialogFocusMode, selectTakesFocus };
}
