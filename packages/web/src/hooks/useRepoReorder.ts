/**
 * セッション一覧のリポジトリのかたまりを、見出しのつまみで並べ替える。
 *
 * - ドラッグはポインタイベントで扱う (一覧はモバイルと共有で、HTML5 の draggable はタッチで動かない)。
 *   つまみに `touch-action: none` を付け、指で掴んでも一覧のスクロールと取り合わない
 * - ドラッグ中は並べ替えた順をその場で描き、指を離したときに1回だけ保存する。取り消し
 *   (pointercancel) では保存しない
 * - ドラッグ中に並べ替えを描くと、つまんだかたまりのDOMが動き、つまみのポインタキャプチャが
 *   外れることがある。外れると指を離しても pointerup が届かず保存されないので、描いたあとに
 *   キャプチャを取り直す
 * - つまみはキーボードの上下キーでも1つずつ動かせる。動かしたあとはフォーカスをつまみに戻す
 *   (かたまりがDOMの中で動くと、ブラウザによってはフォーカスが外れる)
 * - 位置の計算は session-sections.ts の純関数 (moveRepo / resolveDropIndex) に任せる
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { moveRepo, resolveDropIndex } from "@/lib/session-sections";

interface DragState {
  repoPath: string;
  pointerId: number;
  /** つまんだつまみ。DOMが動いたあとにキャプチャを取り直すのに使う */
  handle: HTMLElement;
  order: string[];
}

export interface RepoReorderHandleProps {
  "data-repo-handle": string;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

export function useRepoReorder({
  visibleOrder,
  savedOrder,
  onChange,
  containerRef,
}: {
  /** いま描いているリポジトリの順 */
  visibleOrder: readonly string[];
  /** 保存してある順 (見えていないパスも含む) */
  savedOrder: readonly string[];
  /** 新しい保存値を渡す。無ければ並べ替えできない */
  onChange: ((order: string[]) => void) | undefined;
  /** かたまり (data-repo-group) を子に持つ要素 */
  containerRef: RefObject<HTMLElement | null>;
}): {
  /** 描く順。ドラッグ中はドラッグで並べた順 */
  order: readonly string[];
  /** つまんでいるリポジトリ */
  draggingRepoPath: string | null;
  handleProps: (repoPath: string) => RepoReorderHandleProps;
} {
  const [drag, setDrag] = useState<DragState | null>(null);
  // pointermove は描き直しより速く来るので、最新の状態は ref で読む
  const dragRef = useRef<DragState | null>(null);
  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // 並べ替えを描いた直後 (次のポインタイベントより前) に、外れたキャプチャを取り直す
  useLayoutEffect(() => {
    const current = drag;
    if (!current || !current.handle.isConnected) return;
    if (current.handle.hasPointerCapture?.(current.pointerId) !== false) return;
    try {
      current.handle.setPointerCapture(current.pointerId);
    } catch {
      // ポインタがもう離れている (pointerup が先に来る) なら取り直せない
    }
  }, [drag]);

  const focusAfterMoveRef = useRef<string | null>(null);
  useEffect(() => {
    const repoPath = focusAfterMoveRef.current;
    if (repoPath === null) return;
    focusAfterMoveRef.current = null;
    const handle = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-repo-handle]"
      ) ?? []
    ).find(el => el.dataset.repoHandle === repoPath);
    if (handle && document.activeElement !== handle) handle.focus();
  });

  const handleProps = (repoPath: string): RepoReorderHandleProps => ({
    "data-repo-handle": repoPath,
    onPointerDown: event => {
      if (!onChange || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      updateDrag({
        repoPath,
        pointerId: event.pointerId,
        handle: event.currentTarget,
        order: [...visibleOrder],
      });
    },
    onPointerMove: event => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const midpoints = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          "[data-repo-group]"
        ) ?? []
      )
        .filter(el => el.dataset.repoGroup !== current.repoPath)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
      const next = moveRepo(
        current.order,
        [],
        current.repoPath,
        resolveDropIndex(event.clientY, midpoints)
      );
      if (!sameOrder(next, current.order)) {
        updateDrag({ ...current, order: next });
      }
    },
    onPointerUp: event => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      updateDrag(null);
      if (!onChange || sameOrder(current.order, visibleOrder)) return;
      onChange(
        moveRepo(
          current.order,
          savedOrder,
          current.repoPath,
          current.order.indexOf(current.repoPath)
        )
      );
    },
    onPointerCancel: event => {
      if (dragRef.current?.pointerId === event.pointerId) updateDrag(null);
    },
    onKeyDown: event => {
      if (!onChange) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const index = visibleOrder.indexOf(repoPath);
      const target = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= visibleOrder.length) return;
      focusAfterMoveRef.current = repoPath;
      onChange(moveRepo(visibleOrder, savedOrder, repoPath, target));
    },
  });

  return {
    order: drag?.order ?? visibleOrder,
    draggingRepoPath: drag?.repoPath ?? null,
    handleProps,
  };
}
