import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationPermissionButton } from "./NotificationPermissionButton";

describe("NotificationPermissionButton", () => {
  it("初期描画では権限を自動要求せず、明示操作用ボタンを表示する", () => {
    const onRequestPermission = vi.fn(async () => "granted" as const);
    const html = renderToStaticMarkup(
      createElement(NotificationPermissionButton, {
        supported: true,
        permission: "default",
        onRequestPermission,
      })
    );

    expect(onRequestPermission).not.toHaveBeenCalled();
    expect(html).toContain('aria-label="ブラウザ通知を有効にする"');
  });

  it("Notification API未対応環境ではUIを表示しない", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPermissionButton, {
        supported: false,
        permission: "unsupported",
        onRequestPermission: async () => "unsupported",
      })
    );
    expect(html).toBe("");
  });
});
