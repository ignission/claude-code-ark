// client/src/hooks/useGameLoop.ts
import { useCallback, useEffect, useRef } from "react";

export function useGameLoop(
  callback: (deltaMs: number) => void,
  running: boolean
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const loop = useCallback((time: number) => {
    const delta = lastTimeRef.current ? time - lastTimeRef.current : 16;
    lastTimeRef.current = time;
    callbackRef.current(delta);
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => {
    if (running) {
      lastTimeRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, loop]);
}
