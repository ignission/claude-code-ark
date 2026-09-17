// @vitest-environment jsdom

import { act, type FocusEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHeldOrder, useHeldOrder, useListHold } from "./useHeldOrder";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Item {
  key: string;
  label: string;
}
const keyOf = (i: Item) => i.key;

describe("applyHeldOrder", () => {
  it("前の順を保ち、中身は新しい値を使う", () => {
    const next = [
      { key: "b", label: "B2" },
      { key: "a", label: "A2" },
    ];
    expect(applyHeldOrder(["a", "b"], next, keyOf)).toEqual([
      { key: "a", label: "A2" },
      { key: "b", label: "B2" },
    ]);
  });
  it("新しい要素は末尾に足し、消えた要素は落とす", () => {
    const next = [
      { key: "c", label: "C" },
      { key: "a", label: "A" },
    ];
    expect(applyHeldOrder(["a", "b"], next, keyOf).map(keyOf)).toEqual([
      "a",
      "c",
    ]);
  });
});

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

function Probe({ items, held }: { items: Item[]; held: boolean }) {
  const shown = useHeldOrder(items, keyOf, held);
  return (
    <ul>
      {shown.map(i => (
        <li key={i.key}>{i.label}</li>
      ))}
    </ul>
  );
}

function labels() {
  return [...container.querySelectorAll("li")].map(li => li.textContent);
}

describe("useHeldOrder", () => {
  it("保留中は位置を保ち、解除したら新しい順にする", () => {
    act(() =>
      root.render(
        <Probe
          held={false}
          items={[
            { key: "a", label: "A" },
            { key: "b", label: "B" },
          ]}
        />
      )
    );
    expect(labels()).toEqual(["A", "B"]);

    act(() =>
      root.render(
        <Probe
          held
          items={[
            { key: "b", label: "B*" },
            { key: "a", label: "A" },
          ]}
        />
      )
    );
    expect(labels()).toEqual(["A", "B*"]);

    act(() =>
      root.render(
        <Probe
          held={false}
          items={[
            { key: "b", label: "B*" },
            { key: "a", label: "A" },
          ]}
        />
      )
    );
    expect(labels()).toEqual(["B*", "A"]);
  });
});

type Hold = ReturnType<typeof useListHold>;

function HoldProbe({ onHold }: { onHold: (h: Hold) => void }) {
  const hold = useListHold();
  onHold(hold);
  return <div data-held={String(hold.held)} />;
}

describe("useListHold", () => {
  function setup() {
    let latest: Hold | null = null;
    act(() =>
      root.render(
        <HoldProbe
          onHold={h => {
            latest = h;
          }}
        />
      )
    );
    const current = () => latest as unknown as Hold;
    const held = () =>
      container.querySelector("div")?.getAttribute("data-held");
    return { current, held };
  }

  it("ポインタが上にある間は保留する", () => {
    const { current, held } = setup();
    expect(held()).toBe("false");
    act(() => current().bindings.onPointerEnter());
    expect(held()).toBe("true");
    act(() => current().bindings.onPointerLeave());
    expect(held()).toBe("false");
  });

  it("フォーカスが一覧の外へ出たら解除する", () => {
    const { current, held } = setup();
    act(() => current().bindings.onFocusCapture());
    expect(held()).toBe("true");
    const list = document.createElement("div");
    const inside = document.createElement("button");
    list.appendChild(inside);
    act(() =>
      current().bindings.onBlurCapture({
        currentTarget: list,
        relatedTarget: inside,
      } as unknown as FocusEvent<HTMLElement>)
    );
    expect(held()).toBe("true");
    act(() =>
      current().bindings.onBlurCapture({
        currentTarget: list,
        relatedTarget: null,
      } as unknown as FocusEvent<HTMLElement>)
    );
    expect(held()).toBe("false");
  });

  it("メニューが開いている間とタッチ中は保留する", () => {
    const { current, held } = setup();
    act(() => current().onMenuOpenChange(true));
    expect(held()).toBe("true");
    act(() => current().onMenuOpenChange(false));
    expect(held()).toBe("false");
    act(() => current().bindings.onTouchStart());
    expect(held()).toBe("true");
    act(() => current().bindings.onTouchCancel());
    expect(held()).toBe("false");
  });
});
