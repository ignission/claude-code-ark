/**
 * useStableCallback - 同一性の変わらない関数で、いつも最新の関数を呼ぶ
 *
 * 親が描画のたびに新しい関数 (インラインの矢印関数) を渡してくると、それをそのまま
 * メモ化した子へ渡すだけで、子は毎回描画し直す。この関数で包むと、子へ渡す関数の
 * 同一性は変わらず、呼ばれたときには最新の関数が動く。
 * - 渡された関数が undefined の間は undefined を返す (「この操作は無い」を子へ伝える)
 * - 返す関数は、イベントのハンドラやeffectの中から呼ぶこと。描画中に呼ぶと、
 *   1つ前の描画の関数が動くことがある
 */

import { useCallback, useRef } from "react";

export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result;
export function useStableCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | undefined
): ((...args: Args) => Result) | undefined;
export function useStableCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | undefined
): ((...args: Args) => Result) | undefined {
  const latestRef = useRef(callback);
  latestRef.current = callback;
  const stable = useCallback(
    (...args: Args) =>
      (latestRef.current as (...args: Args) => Result)(...args),
    []
  );
  return callback === undefined ? undefined : stable;
}
