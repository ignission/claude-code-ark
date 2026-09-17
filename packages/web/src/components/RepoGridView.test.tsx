// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  SessionGridSnapshot,
} from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoGridView } from "./RepoGridView";

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

function makeSession(name: string): ManagedSession {
  return {
    id: `id-${name}`,
    worktreeId: `wt-${name}`,
    worktreePath: `/repos/${name}`,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `ark-${name}`,
    ttydPort: 7680,
    ttydUrl: `/ttyd/${name}/`,
  };
}

function makeSnapshot(
  session: ManagedSession,
  status: BridgeSessionStatus,
  elapsedMs = 0
): SessionGridSnapshot {
  return {
    sessionId: session.id,
    repoPath: "/repos",
    name: session.worktreePath.split("/").pop() ?? "",
    status,
    previewText: "",
    currentTask: "",
    elapsedMs,
    capturedAt: 0,
  };
}

function render(
  sessions: ManagedSession[],
  snapshots: SessionGridSnapshot[]
): void {
  act(() =>
    root.render(
      <RepoGridView
        repoPath="/repos"
        sessions={sessions}
        worktreeBranchById={new Map()}
        snapshots={new Map(snapshots.map(s => [s.sessionId, s]))}
        onSubscribe={vi.fn()}
        onUnsubscribe={vi.fn()}
        onSelectSession={vi.fn()}
      />
    )
  );
}

/** セッション名を含むセル (button) を返す */
function cellOf(name: string): HTMLButtonElement {
  const cell = Array.from(container.querySelectorAll("button")).find(b =>
    b.textContent?.includes(name)
  );
  if (!cell) throw new Error(`${name} のセルが無い`);
  return cell;
}

describe("RepoGridView", () => {
  it("状態を設計書の対応表の文言でチップに出す", () => {
    const alpha = makeSession("alpha");
    const bravo = makeSession("bravo");
    const charlie = makeSession("charlie");
    const delta = makeSession("delta");
    render(
      [alpha, bravo, charlie, delta],
      [
        makeSnapshot(alpha, "AWAITING"),
        makeSnapshot(bravo, "IDLE"),
        makeSnapshot(charlie, "THINK"),
        makeSnapshot(delta, "ERR"),
      ]
    );

    const labelOf = (name: string) =>
      cellOf(name).querySelector("[data-status]")?.textContent;
    expect(labelOf("alpha")).toBe("確認待ち");
    expect(labelOf("bravo")).toBe("入力待ち");
    expect(labelOf("charlie")).toBe("作業中");
    expect(labelOf("delta")).toBe("問題");
  });

  it("スナップショットが未着のセルは入力待ちと決めつけない", () => {
    const echo = makeSession("echo");
    render([echo], []);

    const cell = cellOf("echo");
    expect(
      cell.querySelector("[data-status]")?.getAttribute("data-status")
    ).toBe("UNKNOWN");
    expect(cell.textContent).not.toContain("入力待ち");
  });

  it("スナップショットの経過時間を出す", () => {
    const alpha = makeSession("alpha");
    render([alpha], [makeSnapshot(alpha, "TOOL", 65_000)]);

    expect(cellOf("alpha").textContent).toContain("1m 5s");
  });

  it("直書きの色クラスを使わない", () => {
    const alpha = makeSession("alpha");
    const bravo = makeSession("bravo");
    render(
      [alpha, bravo],
      [makeSnapshot(alpha, "TOOL"), makeSnapshot(bravo, "AWAITING")]
    );

    expect(container.innerHTML).not.toMatch(
      /-(green|red|orange|neutral)-\d|bg-black\//
    );
  });
});
