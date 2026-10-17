// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import { useOpenTerminalOnAuq } from "./useOpenTerminalOnAuq";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mountHook(isActive: boolean) {
  const openTerminal = vi.fn();
  let notify: (auq: ActiveAuq | null) => void = () => {};
  function Probe({ active }: { active: boolean }) {
    notify = useOpenTerminalOnAuq(active, openTerminal);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe active={isActive} />));
  mounted = { root, container };
  return {
    openTerminal,
    notify: (auq: ActiveAuq | null) => notify(auq),
    setActive: (active: boolean) =>
      act(() => root.render(<Probe active={active} />)),
  };
}

const auq = (at: number): ActiveAuq => ({
  toolUseId: `hook:${at}`,
  questions: [
    { question: "どちら?", multiSelect: false, options: [{ label: "A" }] },
  ],
});

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

describe("useOpenTerminalOnAuq", () => {
  it("新しい質問が来たら開き、null では開かない", () => {
    const { openTerminal, notify } = mountHook(true);
    notify(null);
    expect(openTerminal).not.toHaveBeenCalled();
    notify(auq(1));
    expect(openTerminal).toHaveBeenCalledTimes(1);
  });

  it("同じ質問が送り直されても (再接続) 開き直さず、次の質問では開く", () => {
    const { openTerminal, notify } = mountHook(true);
    notify(auq(1));
    notify(null);
    notify(auq(1));
    expect(openTerminal).toHaveBeenCalledTimes(1);
    notify(auq(2));
    expect(openTerminal).toHaveBeenCalledTimes(2);
  });

  it("表示中でなければ開かず、表示し直して同じ質問が届いたら開く", () => {
    const { openTerminal, notify, setActive } = mountHook(false);
    notify(auq(1));
    expect(openTerminal).not.toHaveBeenCalled();
    setActive(true);
    notify(auq(1));
    expect(openTerminal).toHaveBeenCalledTimes(1);
  });
});
