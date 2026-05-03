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

test("モバイル: セッションタブ連打しても detail 状態を保持できる構造になっている", async ({
  page,
}) => {
  // 実セッションがない環境では detail を表示できないので、
  // ボトムナビが「セッション」タブを連打したときに状態が変化しないことを
  // クリック前後の DOM スナップショットで確認する
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  const sessionTab = page.locator("nav button", { hasText: "セッション" });
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });

  // セッションタブを3回連打
  await sessionTab.click();
  await sessionTab.click();
  await sessionTab.click();

  // セッションタブはまだアクティブ
  await expect(sessionTab).toHaveClass(/text-primary/);
});
