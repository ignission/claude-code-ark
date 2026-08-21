import { expect, test } from "@playwright/test";

/**
 * モバイル: セッション状態の永続化値の検証
 *
 * 実セッション起動には Claude CLI 起動が必要なので、
 * ここではボトムナビとタブ間遷移のみ検証する。
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };

// 各テスト前にモバイル UI 設定を初期化（前テストの永続化値を持ち越さない）。
// selectedSessionId も openedSessions seed や detail 表示可否に影響するので必ず null に戻す
test.beforeEach(async ({ request }) => {
  await request.put("/api/settings", {
    data: {
      selectedSessionId: null,
      "mobile.activeTab": "session",
      "mobile.sessionSubView": "list",
    },
  });
});

test("モバイル: 不正な永続化値を受信しても安全な値にフォールバックする", async ({
  page,
  request,
}) => {
  // 壊れた値が settings に入ってもクラッシュせず default にフォールバック
  await request.put("/api/settings", {
    data: {
      "mobile.activeTab": "garbage",
      "mobile.sessionSubView": 42,
    },
  });

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  const sessionTab = page.locator("nav button", { hasText: "セッション" });
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });
  // 不正値は "session" にフォールバックするはず
  await expect(sessionTab).toHaveClass(/text-primary/);
});
