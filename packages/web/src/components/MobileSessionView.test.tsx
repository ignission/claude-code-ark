import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  getViewModeForActiveTab,
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

  it.each([
    { activeTabType: "diagram", expected: "board", label: "図" },
    { activeTabType: "file", expected: "terminal", label: "ファイル" },
    { activeTabType: "html", expected: "terminal", label: "HTML" },
  ] as const)(
    "active な $label タブに合わせて $expected モードへ切り替える",
    ({ activeTabType, expected }) => {
      expect(getViewModeForActiveTab(activeTabType)).toBe(expected);
    }
  );

  it("terminal タブでは表示モードを変えない", () => {
    expect(getViewModeForActiveTab("terminal")).toBeNull();
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
