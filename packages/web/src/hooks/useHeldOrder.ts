/**
 * 一覧の並び替えの保留 (設計書 7 節)。
 *
 * 状態が変わると行がセクションをまたいで動く。クリックしようとした行が動いて
 * 別のセッションを開く事故を防ぐため、ポインタが上にある・フォーカスがある・
 * メニューが開いている・タッチ中の間は、行の位置を前の並びのまま保つ。
 * 行の中身 (状態チップ) は保留中も最新にする。
 */

import {
  type FocusEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export function applyHeldOrder<T>(
  previousKeys: readonly string[],
  items: readonly T[],
  getKey: (item: T) => string
): T[] {
  const byKey = new Map(items.map(item => [getKey(item), item] as const));
  const result: T[] = [];
  const placed = new Set<string>();
  for (const key of previousKeys) {
    const item = byKey.get(key);
    if (item !== undefined) {
      result.push(item);
      placed.add(key);
    }
  }
  for (const item of items) {
    if (!placed.has(getKey(item))) result.push(item);
  }
  return result;
}

export function useHeldOrder<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  held: boolean
): T[] {
  const shownKeysRef = useRef<string[]>([]);
  const shown = held
    ? applyHeldOrder(shownKeysRef.current, items, getKey)
    : [...items];

  useEffect(() => {
    shownKeysRef.current = shown.map(getKey);
  });

  return shown;
}

export interface ListHoldBindings {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusCapture: () => void;
  onBlurCapture: (e: FocusEvent<HTMLElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export function useListHold(): {
  held: boolean;
  bindings: ListHoldBindings;
  onMenuOpenChange: (open: boolean) => void;
} {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [touching, setTouching] = useState(false);
  const [openMenus, setOpenMenus] = useState(0);

  const bindings = useMemo<ListHoldBindings>(
    () => ({
      onPointerEnter: () => setPointerInside(true),
      onPointerLeave: () => setPointerInside(false),
      onFocusCapture: () => setFocusInside(true),
      onBlurCapture: e => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setFocusInside(false);
      },
      onTouchStart: () => setTouching(true),
      onTouchEnd: () => setTouching(false),
      onTouchCancel: () => setTouching(false),
    }),
    []
  );

  // メニューは Portal に描かれ、ポインタ判定では拾えないので開閉で数える
  const onMenuOpenChange = useCallback((open: boolean) => {
    setOpenMenus(n => Math.max(0, n + (open ? 1 : -1)));
  }, []);

  return {
    held: pointerInside || focusInside || touching || openMenus > 0,
    bindings,
    onMenuOpenChange,
  };
}
