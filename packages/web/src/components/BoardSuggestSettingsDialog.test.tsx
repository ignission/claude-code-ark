// @vitest-environment jsdom

import type {
  BoardSuggestConfig,
  BoardSuggestConfigPatch,
  BoardSuggestConfigResult,
} from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardSuggestSettingsDialog } from "./BoardSuggestSettingsDialog";

// Radix の Dialog は Portal と pointer イベントが絡むので素通しにする
// (ScreenManagerDialog.test.tsx と同じ)
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  useDialogComposition: () => ({
    isComposing: () => false,
    setComposing: () => {},
    justEndedComposing: () => false,
    markCompositionEnd: () => {},
  }),
}));

/** サーバーの代わり。保存のたびに現在の設定を更新して返す */
function createBackend(initial: BoardSuggestConfig) {
  let current = initial;
  const saved: BoardSuggestConfigPatch[] = [];
  const onLoad = vi.fn(
    async (): Promise<BoardSuggestConfigResult> => ({
      ok: true,
      config: current,
    })
  );
  const onSave = vi.fn(
    async (
      patch: BoardSuggestConfigPatch
    ): Promise<BoardSuggestConfigResult> => {
      saved.push(patch);
      if (patch.apiKey === "bad") {
        return { ok: false, error: "API キーの形式が不正です" };
      }
      current = {
        ...current,
        enabled: patch.enabled ?? current.enabled,
        threshold: patch.threshold ?? current.threshold,
        ...(patch.apiKey === null
          ? { keyConfigured: false, keyHint: null, keySource: null }
          : patch.apiKey
            ? {
                keyConfigured: true,
                keyHint: patch.apiKey.slice(-4),
                keySource: "settings" as const,
              }
            : {}),
      };
      return { ok: true, config: current };
    }
  );
  return { onLoad, onSave, saved };
}

// Radix の Checkbox が ResizeObserver を使う (jsdom に無い)
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

/** マウントし、onLoad の Promise が反映されるまで待つ */
async function mountDialog(config: BoardSuggestConfig) {
  const backend = createBackend(config);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BoardSuggestSettingsDialog
        open
        onOpenChange={() => {}}
        onLoad={backend.onLoad}
        onSave={backend.onSave}
      />
    );
  });
  roots.push({ root, container });
  return backend;
}

function input(id: string): HTMLInputElement {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`input #${id} が無い`);
  return el;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll("button")].find(
    b => b.textContent?.trim() === text
  );
  if (!el) throw new Error(`ボタン「${text}」が無い`);
  return el;
}

async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}

describe("BoardSuggestSettingsDialog", () => {
  it("開くと設定を取得し、鍵は末尾 4 文字と出どころだけ見せる", async () => {
    const backend = await mountDialog({
      enabled: true,
      threshold: 0.7,
      keyConfigured: true,
      keyHint: "1234",
      keySource: "file",
    });
    expect(backend.onLoad).toHaveBeenCalledTimes(1);
    expect(input("board-suggest-api-key").value).toBe("");
    expect(input("board-suggest-api-key").placeholder).toContain("1234");
    expect(document.body.textContent).toContain("~/.config/openrouter/api-key");
    // ファイル由来の鍵はこの画面から消せない
    expect(document.body.textContent).not.toContain("鍵を削除");
  });

  it("保存で enabled / threshold と、入力したときだけ鍵を送る", async () => {
    const backend = await mountDialog({
      enabled: true,
      threshold: 0.7,
      keyConfigured: false,
      keyHint: null,
      keySource: null,
    });
    setValue(input("board-suggest-threshold"), "0.85");
    await click("保存");
    expect(backend.saved[0]).toEqual({ enabled: true, threshold: 0.85 });

    setValue(input("board-suggest-api-key"), "sk-or-v1-abcdef9876");
    await click("保存");
    expect(backend.saved[1]).toEqual({
      enabled: true,
      threshold: 0.85,
      apiKey: "sk-or-v1-abcdef9876",
    });
    // 保存後は入力欄を空にし、末尾 4 文字だけ出す
    expect(input("board-suggest-api-key").value).toBe("");
    expect(input("board-suggest-api-key").placeholder).toContain("9876");
    expect(document.body.textContent).toContain("保存しました");
    expect(document.body.textContent).toContain("鍵を削除");
  });

  it("サーバーの拒否理由を表示し、鍵の削除は apiKey: null を送る", async () => {
    const backend = await mountDialog({
      enabled: true,
      threshold: 0.7,
      keyConfigured: true,
      keyHint: "zzzz",
      keySource: "settings",
    });
    setValue(input("board-suggest-api-key"), "bad");
    await click("保存");
    expect(document.body.textContent).toContain("API キーの形式が不正です");

    await click("鍵を削除");
    expect(backend.saved.at(-1)).toEqual({ apiKey: null });
    expect(document.body.textContent).not.toContain("鍵を削除");
    expect(input("board-suggest-api-key").placeholder).toBe("sk-or-v1-…");
  });

  it("閾値が範囲外なら送らずに理由を出す", async () => {
    const backend = await mountDialog({
      enabled: true,
      threshold: 0.7,
      keyConfigured: false,
      keyHint: null,
      keySource: null,
    });
    setValue(input("board-suggest-threshold"), "1.5");
    await click("保存");
    expect(backend.saved).toEqual([]);
    expect(document.body.textContent).toContain("閾値は 0〜1 の数値です");
  });
});
