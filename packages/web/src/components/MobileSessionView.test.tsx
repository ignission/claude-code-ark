import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createDiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  getViewModeForViewerTab,
  normalizeMobileSessionViewMode,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import {
  MOBILE_SESSION_VIEW_MODES,
  MobileSessionViewModeToggle,
} from "./MobileSessionViewModeToggle";

describe("mobile session view mode", () => {
  it("chat / terminal / board を正規化し、不正値は chat へ戻す", () => {
    expect(MOBILE_SESSION_VIEW_MODES.map(option => option.value)).toEqual([
      "chat",
      "terminal",
      "board",
    ]);
    expect(normalizeMobileSessionViewMode("chat")).toBe("chat");
    expect(normalizeMobileSessionViewMode("terminal")).toBe("terminal");
    expect(normalizeMobileSessionViewMode("board")).toBe("board");
    expect(normalizeMobileSessionViewMode("unknown")).toBe("chat");
    expect(normalizeMobileSessionViewMode(null)).toBe("chat");
  });

  it("board を永続化する", () => {
    const storage = { setItem: vi.fn() };

    writeSavedViewMode("board", storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      "ark-mobile-session-view",
      "board"
    );
  });

  it("同じ図を続けて開いても通知が変化し、毎回 board へ切り替える", () => {
    const first = createDiagramOpenRequest(
      null,
      "session-1",
      ".claude/diagrams/mobile.diagram.html"
    );
    const second = createDiagramOpenRequest(
      first,
      "session-1",
      ".claude/diagrams/mobile.diagram.html"
    );

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(getViewModeForDiagramOpenRequest("session-1", first, null)).toBe(
      "board"
    );
    expect(
      getViewModeForDiagramOpenRequest("session-1", second, first.sequence)
    ).toBe("board");
  });

  it("別セッション向け、処理済み、通知なしでは表示モードを変えない", () => {
    const request = createDiagramOpenRequest(
      null,
      "session-2",
      ".claude/diagrams/mobile.diagram.html"
    );

    expect(
      getViewModeForDiagramOpenRequest("session-1", request, null)
    ).toBeNull();
    expect(
      getViewModeForDiagramOpenRequest("session-2", request, request.sequence)
    ).toBeNull();
    // reload 復元は diagram:open 通知を作らない。
    expect(
      getViewModeForDiagramOpenRequest("session-1", null, null)
    ).toBeNull();
  });

  it.each(["file", "html"] as const)(
    "active な %s ビューワータブでは従来どおり terminal へ切り替える",
    activeTabType => {
      expect(getViewModeForViewerTab(activeTabType)).toBe("terminal");
    }
  );

  it("terminal タブでは表示モードを変えない", () => {
    expect(getViewModeForViewerTab("terminal")).toBeNull();
  });

  it("現在モードが分かる 3 択トグルを表示する", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileSessionViewModeToggle, {
        value: "board",
        onChange: vi.fn(),
      })
    );

    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain("💬");
    expect(markup).toContain("会話");
    expect(markup).toContain("🖥");
    expect(markup).toContain("端末");
    expect(markup).toContain("📐");
    expect(markup).toContain("図");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="図"');
  });
});
