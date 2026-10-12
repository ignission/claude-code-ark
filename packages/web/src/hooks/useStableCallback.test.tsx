// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStableCallback } from "./useStableCallback";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mountHook(initial: ((value: string) => string) | undefined) {
  const seen: Array<((value: string) => string) | undefined> = [];
  function Probe({ fn }: { fn: ((value: string) => string) | undefined }) {
    seen.push(useStableCallback(fn));
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe fn={initial} />));
  mounted = { root, container };
  return {
    seen,
    rerender: (fn: ((value: string) => string) | undefined) =>
      act(() => root.render(<Probe fn={fn} />)),
  };
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (!mounted) return;
  const { root, container } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
});

describe("useStableCallback", () => {
  it("関数が差し替わっても同じ関数を返し、呼ぶと最新の関数が動く", () => {
    const first = vi.fn((value: string) => `first:${value}`);
    const second = vi.fn((value: string) => `second:${value}`);
    const { seen, rerender } = mountHook(first);

    rerender(second);

    expect(seen[1]).toBe(seen[0]);
    expect(seen[1]?.("a")).toBe("second:a");
    expect(first).not.toHaveBeenCalled();
  });

  it("関数が無い間は undefined を返す", () => {
    const { seen, rerender } = mountHook(undefined);
    expect(seen[0]).toBeUndefined();

    rerender(value => value);
    expect(seen[1]).toBeTypeOf("function");

    rerender(undefined);
    expect(seen[2]).toBeUndefined();
  });
});
