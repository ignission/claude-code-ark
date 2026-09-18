// @vitest-environment jsdom

import { MessagesSquare, SquareTerminal } from "lucide-react";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";

type Mode = "terminal" | "chat";

const OPTIONS: readonly SegmentOption<Mode>[] = [
  { value: "terminal", label: "端末", icon: SquareTerminal },
  { value: "chat", label: "会話", icon: MessagesSquare },
];

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SegmentedControl", () => {
  it("選択中の項目だけaria-pressed=trueにする", () => {
    const container = mount(
      <SegmentedControl options={OPTIONS} value="chat" onChange={vi.fn()} />
    );

    expect(findButton(container, "会話").getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(findButton(container, "端末").getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("押した項目の値をonChangeに渡す", () => {
    const onChange = vi.fn();
    const container = mount(
      <SegmentedControl options={OPTIONS} value="chat" onChange={onChange} />
    );

    act(() => findButton(container, "端末").click());

    expect(onChange).toHaveBeenCalledWith("terminal");
  });

  it("文言を表示し、アイコンは読み上げから外す", () => {
    const container = mount(
      <SegmentedControl options={OPTIONS} value="terminal" onChange={vi.fn()} />
    );

    expect(findButton(container, "端末").textContent).toBe("端末");
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(
      2
    );
  });

  it("labelClassNameは各項目の文言のspanにだけ当て、読み上げからは消さない", () => {
    const container = mount(
      <SegmentedControl
        options={OPTIONS}
        value="terminal"
        onChange={vi.fn()}
        labelClassName="@max-2xl:sr-only"
      />
    );

    const button = findButton(container, "端末");
    expect(button.querySelector("span")?.className).toBe("@max-2xl:sr-only");
    // 視覚的に隠すだけなので、文言そのものは残る
    expect(button.textContent).toBe("端末");
    expect(button.className).not.toContain("sr-only");
  });

  it("labelClassNameを渡さない既存の呼び出しでは、文言のspanに class を付けない", () => {
    const container = mount(
      <SegmentedControl options={OPTIONS} value="terminal" onChange={vi.fn()} />
    );

    expect(
      findButton(container, "端末").querySelector("span")?.getAttribute("class")
    ).toBeNull();
  });

  it("labelを渡すと、まとまりの読み上げ名にする", () => {
    const container = mount(
      <SegmentedControl
        label="左ペインの表示"
        options={OPTIONS}
        value="terminal"
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector("fieldset > legend")?.textContent).toBe(
      "左ペインの表示"
    );
  });
});
