import { expect, test } from "@playwright/test";

/**
 * モバイル: セッション状態の永続化とタブ間復元
 *
 * - リロード時に最後のタブを復元
 * - 「セッション」タブを Beacon から戻った時に detail を保持
 * - 「セッション」タブ連打しても detail のまま
 *
 * 実セッション起動には Claude CLI 起動が必要なので、
 * ここではボトムナビとタブ間遷移のみ検証する。
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };

// settings は1つのDBを共有するため、テストをシリアル実行して相互干渉を防ぐ
test.describe.configure({ mode: "serial" });

// 各テスト前にモバイル UI 設定を初期化（前テストの永続化値を持ち越さない）
test.beforeEach(async ({ request }) => {
  await request.put("/api/settings", {
    data: {
      "mobile.activeTab": "session",
      "mobile.sessionSubView": "list",
    },
  });
});

test("モバイル: ボトムナビでタブ切替するとアクティブタブがハイライトされる", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  const sessionTab = page.locator("nav button", { hasText: "セッション" });
  const beaconTab = page.locator("nav button", { hasText: "Beacon" });
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });
  await expect(beaconTab).toBeVisible();

  // 初期状態: セッションタブがアクティブ (text-primary)
  await expect(sessionTab).toHaveClass(/text-primary/);
  await expect(beaconTab).not.toHaveClass(/text-primary/);

  // Beacon タブをクリック
  await beaconTab.click();
  await expect(beaconTab).toHaveClass(/text-primary/);
  await expect(sessionTab).not.toHaveClass(/text-primary/);

  // セッションタブに戻ると再度アクティブ
  await sessionTab.click();
  await expect(sessionTab).toHaveClass(/text-primary/);
  await expect(beaconTab).not.toHaveClass(/text-primary/);
});

test("モバイル: リロードしても最後のタブが復元される (Beacon)", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  // Beacon に切替
  const beaconTab = page.locator("nav button", { hasText: "Beacon" });
  await expect(beaconTab).toBeVisible({ timeout: 15_000 });
  await beaconTab.click();
  await expect(beaconTab).toHaveClass(/text-primary/);

  // 設定がサーバーに永続化されるのを待つ (debounce 300ms + 余裕)
  await page.waitForTimeout(800);

  // リロード
  await page.reload();

  // 復元後も Beacon がアクティブ
  await expect(beaconTab).toBeVisible({ timeout: 15_000 });
  await expect(beaconTab).toHaveClass(/text-primary/, { timeout: 5_000 });
});

test("モバイル: Beacon→セッションタブ往復で sessionSubView が detail のまま保持される", async ({
  page,
  request,
}) => {
  // sessionSubView=detail を直接サーバー設定に書き込んで、
  // Beacon タブへ遷移→セッションタブへ戻った後も detail が保持されることを検証する
  // (実セッション無しでも sessionSubView の永続化値は保持される必要がある)
  await request.put("/api/settings", {
    data: {
      "mobile.activeTab": "session",
      "mobile.sessionSubView": "detail",
    },
  });

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  const sessionTab = page.locator("nav button", { hasText: "セッション" });
  const beaconTab = page.locator("nav button", { hasText: "Beacon" });
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });

  // 設定の load を待つ
  await page.waitForTimeout(500);

  // Beacon に切替 → セッションに戻す
  await beaconTab.click();
  await expect(beaconTab).toHaveClass(/text-primary/);
  await sessionTab.click();
  await expect(sessionTab).toHaveClass(/text-primary/);

  // サーバーの sessionSubView 設定が "detail" を保ったままであることを確認
  // (Beacon 遷移で list に flip されないことが回帰防止の本質)
  await page.waitForTimeout(500);
  const settings = await request.get("/api/settings").then(r => r.json());
  expect(settings["mobile.sessionSubView"]).toBe("detail");
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
