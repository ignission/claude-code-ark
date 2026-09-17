// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatusKey } from "../lib/status-tone";
import { StatusChip } from "./StatusChip";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(statusKey: StatusKey) {
  act(() => root.render(<StatusChip statusKey={statusKey} />));
  return container.querySelector(`[data-status="${statusKey}"]`) as HTMLElement;
}

describe("StatusChip", () => {
  it("文言とアイコンを出す", () => {
    const chip = render("AWAITING");
    expect(chip.textContent).toBe("確認待ち");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.className).toContain("text-status-awaiting");
    expect(chip.className).toContain("bg-status-awaiting/15");
  });

  it("作業中は呼吸する3点を出す", () => {
    const chip = render("TOOL");
    expect(chip.textContent).toBe("作業中");
    expect(chip.querySelectorAll(".status-dots > span")).toHaveLength(3);
  });

  it("未起動は枠線のチップ", () => {
    const chip = render("NOT_STARTED");
    expect(chip.textContent).toBe("未起動");
    expect(chip.className).toContain("border");
    expect(chip.className).not.toContain("bg-status-neutral/15");
  });

  it("状態が未着なら文言なしの小さな印だけを出し、読み上げない", () => {
    const chip = render("UNKNOWN");
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-hidden")).toBe("true");
  });
});
