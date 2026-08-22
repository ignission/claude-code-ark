import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPermissionButton } from "./NotificationPermissionButton";

const state = vi.hoisted(() => ({ requesting: false }));

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: () => [
      state.requesting,
      (requesting: boolean) => {
        state.requesting = requesting;
      },
    ],
  };
});

describe("NotificationPermissionButton", () => {
  beforeEach(() => {
    state.requesting = false;
  });

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

  it("権限要求がrejectしてもボタンを再び押せる状態に戻す", async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    const onRequestPermission = vi.fn(
      () =>
        new Promise<NotificationPermission>((_resolve, reject) => {
          rejectRequest = reject;
        })
    );
    const renderButton = () =>
      NotificationPermissionButton({
        supported: true,
        permission: "default",
        onRequestPermission,
      }) as ReactElement<{
        disabled: boolean;
        onClick: () => Promise<void>;
      }>;

    let button = renderButton();
    expect(button.props.disabled).toBe(false);

    const request = button.props.onClick();
    button = renderButton();
    expect(button.props.disabled).toBe(true);

    rejectRequest?.(new Error("permission request failed"));
    await expect(request).rejects.toThrow("permission request failed");

    button = renderButton();
    expect(button.props.disabled).toBe(false);
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
  });
});
