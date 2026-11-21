// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { m } from "@/lib/i18n";
import { HomeBackBar, HomeSessionRow } from "./HomeSessionRow";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HomeSessionRow", () => {
  it("動いているホームは補足を出し、押すと開く", () => {
    const onOpen = vi.fn();
    act(() =>
      root.render(
        <HomeSessionRow
          variant="sidebar"
          subLabel="note"
          statusKey="IDLE"
          running
          selected
          onOpen={onOpen}
          onUnset={vi.fn()}
        />
      )
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-home-row] button[aria-current="true"]'
    );
    expect(button?.textContent).toContain(m.session.home.label);
    expect(button?.textContent).toContain("note");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("未起動のホームは、押すと起動することを言う", () => {
    act(() =>
      root.render(
        <HomeSessionRow
          variant="card"
          subLabel="note"
          statusKey="NOT_STARTED"
          running={false}
          selected={false}
          onOpen={vi.fn()}
          onUnset={vi.fn()}
        />
      )
    );
    expect(container.textContent).toContain(m.session.home.notRunning);
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });
});

describe("HomeBackBar", () => {
  it("開いているセッションの名前を出し、押すとホームへ戻る", () => {
    const onBack = vi.fn();
    act(() =>
      root.render(<HomeBackBar label="fix-fee-display" onBack={onBack} />)
    );
    expect(container.textContent).toContain("fix-fee-display");
    act(() => container.querySelector("button")?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
