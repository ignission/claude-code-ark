// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYNAV_LEADER_EVENT } from "@/hooks/useTerminalLeaderKey";
import { KeyNavLayer } from "./KeyNavLayer";

/** 作業エリアを開閉でき、タブを替えると中身が替わる、最小の画面 */
function mountScreen({ workOpen }: { workOpen: boolean }) {
  const screen = document.createElement("div");
  screen.innerHTML = `
    <div data-keynav-region="sidebar"><div data-session-list></div></div>
    <div data-keynav-region="left"><button aria-label="パネル"></button></div>
    <div data-keynav-region="work" class="${workOpen ? "" : "hidden"}">
      <div role="tablist" aria-label="パネルの表示">
        <button role="tab" aria-selected="false">図</button>
        <button role="tab" aria-selected="true">ファイル</button>
        <button role="tab" aria-selected="false">Git</button>
      </div>
      <div role="tree"><div role="treeitem" tabindex="0" id="row"></div></div>
      <div role="listbox" tabindex="0" id="commits"></div>
    </div>`;
  document.body.append(screen);
  const work = screen.querySelector<HTMLElement>('[data-keynav-region="work"]');
  screen
    .querySelector('button[aria-label="パネル"]')
    ?.addEventListener("click", () => work?.classList.toggle("hidden"));
  const tabs = [...screen.querySelectorAll<HTMLElement>('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const each of tabs) {
        each.setAttribute("aria-selected", String(each === tab));
      }
    });
  }
  return {
    work,
    selectedTab: () =>
      tabs.find(tab => tab.getAttribute("aria-selected") === "true")
        ?.textContent,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<KeyNavLayer />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  delete document.documentElement.dataset.keynavMode;
  delete document.documentElement.dataset.keynavActive;
  vi.useRealTimers();
});

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, cancelable: true, ...init })
    );
  });
}
function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}
const activeRegion = () => document.documentElement.dataset.keynavActive;

describe("KeyNavLayer", () => {
  it("図の中から来た合図では、作業エリアからノーマルモードを始める", () => {
    mountScreen({ workOpen: true });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(KEYNAV_LEADER_EVENT, { detail: { region: "work" } })
      );
    });
    expect(activeRegion()).toBe("work");
  });

  it("端末の中から来た合図 (場所を載せない) では、覚えている場所から始める", () => {
    mountScreen({ workOpen: true });
    act(() => {
      window.dispatchEvent(new Event(KEYNAV_LEADER_EVENT));
    });
    expect(activeRegion()).toBe("left");
  });

  it("いた場所が無くなっていたら、左のパネルにいるものとして指示を受ける", () => {
    const screen = mountScreen({ workOpen: true });
    press(";", { ctrlKey: true });
    press("l");
    expect(activeRegion()).toBe("work");
    // セッションを替えた先で、作業エリアが閉じている
    screen.work?.classList.add("hidden");
    press("h");
    expect(activeRegion()).toBe("sidebar");
  });

  it("閉じた作業エリアで gs を打つと、Git に替わったあとの一覧へフォーカスを置く", () => {
    const screen = mountScreen({ workOpen: false });
    press(";", { ctrlKey: true });
    press("g");
    press("s");
    wait(30);
    // まだ「ファイル」のまま (タブを選ぶのは作業エリアが開いてから)
    expect(screen.selectedTab()).toBe("ファイル");
    wait(600);
    expect(screen.selectedTab()).toBe("Git");
    expect(document.activeElement?.id).toBe("commits");
  });

  it("後回しにしたタブの選択は、次の指示が来たら捨てる", () => {
    const screen = mountScreen({ workOpen: false });
    press(";", { ctrlKey: true });
    press("g");
    press("d");
    wait(10);
    press("g");
    press("f");
    wait(600);
    expect(screen.selectedTab()).toBe("ファイル");
  });
});
