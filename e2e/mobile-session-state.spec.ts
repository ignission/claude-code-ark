import { expect, test } from "@playwright/test";

/**
 * モバイル: セッション状態の永続化値の検証
 *
 * 実セッション起動にはClaude CLIの起動が必要なので、
 * ここでは永続化値のフォールバックを一覧の表示で確かめる。
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };

// 各テスト前にモバイルUI設定を初期化 (前テストの永続化値を持ち越さない)。
// selectedSessionIdもopenedSessionsの初期値やdetail表示可否に影響するので必ずnullに戻す
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
  // 壊れた値がsettingsに入ってもクラッシュせずdefaultにフォールバック
  await request.put("/api/settings", {
    data: {
      "mobile.activeTab": "garbage",
      "mobile.sessionSubView": 42,
    },
  });

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  // activeTab="session" / sessionSubView="list" にフォールバックすれば一覧の見出しが見える
  await expect(
    page.getByRole("heading", { level: 1, name: "Ark" })
  ).toBeVisible({ timeout: 15_000 });
  // localhostではブラウザのタブが無いので、下部タブも出さない
  await expect(page.locator("nav")).toHaveCount(0);
});
