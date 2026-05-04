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

test("モバイル: ボトムナビ操作自体は sessionSubView を破壊しない", async ({
  page,
  request,
}) => {
  // 「セッション」タブを再クリックしても sessionSubView が "list" にリセットされないこと
  // (旧実装は setActiveView("list") していたため detail が失われていた。
  //  実セッション無しでは fallback で list に戻るので、ボトムナビ自体の挙動だけ検証する)
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  const sessionTab = page.locator("nav button", { hasText: "セッション" });
  const beaconTab = page.locator("nav button", { hasText: "Beacon" });
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });

  // 初期化反映待ち
  await page.waitForTimeout(500);

  // Beacon → 「セッション」タブ → Beacon → 「セッション」タブ と往復
  await beaconTab.click();
  await sessionTab.click();
  await beaconTab.click();
  await sessionTab.click();

  // 操作後の永続化値: activeTab=session, sessionSubView=list (初期値のまま破壊されない)
  await page.waitForTimeout(500);
  const settings = await request.get("/api/settings").then(r => r.json());
  expect(settings["mobile.activeTab"]).toBe("session");
  expect(settings["mobile.sessionSubView"]).toBe("list");
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
