// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarMainLayout } from "./SidebarMainLayout";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

/** サイドバーは幅をインラインで持つ唯一の要素 */
function sidebarWidth(container: HTMLDivElement): number {
  const el = container.querySelector<HTMLElement>("div[style*='width']");
  expect(el).not.toBeNull();
  return Number.parseInt((el as HTMLElement).style.width, 10);
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function layout(initialSidebarWidth: number, onChange = vi.fn()): ReactElement {
  return (
    <SidebarMainLayout
      sidebar={<div>sidebar</div>}
      main={<div>main</div>}
      initialSidebarWidth={initialSidebarWidth}
      onSidebarWidthChange={onChange}
    />
  );
}

/** ハンドルを掴んで clientX まで引き、離す */
function dragTo(container: HTMLDivElement, clientX: number): void {
  const handle = container.querySelector<HTMLElement>(
    "div[class*='cursor-col-resize']"
  );
  expect(handle).not.toBeNull();
  act(() =>
    (handle as HTMLElement).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    )
  );
  act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX })));
  act(() => document.dispatchEvent(new MouseEvent("mouseup")));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setViewportWidth(1280);
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SidebarMainLayout のサイドバー幅", () => {
  it("保存済みの幅が広すぎるときは、読み込み時に丸める", () => {
    setViewportWidth(860);
    expect(sidebarWidth(mount(layout(450)))).toBe(380);
  });

  it("ユーザーの実設定 (253px) は、狭いウィンドウでも丸めない", () => {
    setViewportWidth(768);
    expect(sidebarWidth(mount(layout(253)))).toBe(253);
  });

  it("ドラッグでも上限を超えられない", () => {
    setViewportWidth(860);
    const container = mount(layout(300));

    dragTo(container, 1000);

    expect(sidebarWidth(container)).toBe(380);
  });

  it("広いまま保存したあとウィンドウを縮めても、メインペインを潰さない", () => {
    setViewportWidth(1280);
    const container = mount(layout(450));
    expect(sidebarWidth(container)).toBe(450);

    setViewportWidth(860);
    act(() => window.dispatchEvent(new Event("resize")));

    expect(sidebarWidth(container)).toBe(380);
  });

  it("ウィンドウを広げ直したら、丸める前に選んでいた幅に戻す", () => {
    setViewportWidth(1280);
    const container = mount(layout(450));

    setViewportWidth(768);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(sidebarWidth(container)).toBe(288);

    setViewportWidth(1280);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(sidebarWidth(container)).toBe(450);
  });

  it("リサイズでの丸めは保存しない (ユーザーが選んだ幅を残す)", () => {
    const onChange = vi.fn();
    setViewportWidth(1280);
    const container = mount(layout(450, onChange));

    setViewportWidth(860);
    act(() => window.dispatchEvent(new Event("resize")));

    expect(sidebarWidth(container)).toBe(380);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ドラッグして離したときは、丸めた幅を保存する", () => {
    const onChange = vi.fn();
    setViewportWidth(860);
    const container = mount(layout(300, onChange));

    dragTo(container, 1000);

    expect(onChange).toHaveBeenCalledWith(380);
  });
});
