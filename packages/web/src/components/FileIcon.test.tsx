// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/file-icon-assets", () => ({
  iconUrl: (name: string) =>
    name === "typescript" || name === "folder-src-open"
      ? `/icons/${name}.svg`
      : undefined,
}));

import { FileIcon } from "./FileIcon";

const containers: HTMLElement[] = [];

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return container;
}

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

describe("FileIcon", () => {
  it("読み込み前は lucide の代替を出し、読み込み後に img へ替わる", async () => {
    const c = document.createElement("div");
    document.body.append(c);
    containers.push(c);
    const root = createRoot(c);
    // 読み込みの完了を待たずに最初の描画だけ確かめる
    act(() => root.render(<FileIcon name="a.ts" kind="file" />));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("svg")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
      await new Promise(r => setTimeout(r, 0));
    });
    const img = c.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/icons/typescript.svg");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
  });

  it("開いたディレクトリは open の SVG を使う", async () => {
    const c = await render(<FileIcon name="src" kind="dir" open />);
    expect(c.querySelector("img")?.getAttribute("src")).toBe(
      "/icons/folder-src-open.svg"
    );
  });

  it("対応が無い・資産が無いときは代替のまま", async () => {
    const c = await render(
      <>
        <FileIcon name="unknown.xyz" kind="file" />
        <FileIcon name="src" kind="dir" />
      </>
    );
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelectorAll("svg")).toHaveLength(2);
  });
});
