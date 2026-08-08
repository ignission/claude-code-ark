import { expect, type Page, test } from "@playwright/test";
import { injectBuiltinProjection } from "../packages/server/src/lib/diagram-builtin";
import { injectHarness } from "../packages/server/src/lib/diagram-harness";
import type { DiagramModel } from "../packages/server/src/lib/diagram-model";

/**
 * 内蔵図種（model の type だけで投影を生成する経路）の実機確認。
 * 生成物が書くのはモデル JSON だけで、DOM も CSS もサーバーが作る。
 */

const erModel: DiagramModel = {
  version: 1,
  type: "er",
  title: "注文まわり",
  nodes: [
    {
      id: "customer",
      label: "Customer",
      kind: "entity",
      fields: [{ id: "c_id", label: "id PK" }],
    },
    {
      id: "order",
      label: "Order",
      kind: "root",
      fields: [
        { id: "o_id", label: "id PK" },
        { id: "o_customer", label: "customer_id FK" },
      ],
    },
  ],
  edges: [
    {
      id: "e_places",
      from: "customer",
      to: "order",
      label: "places",
      ext: { from_card: "one", to_card: "zero-or-many", type: "identifying" },
    },
  ],
  groups: [{ id: "ordering", label: "Ordering", nodes: ["customer", "order"] }],
};

const stormingModel: DiagramModel = {
  version: 1,
  type: "event-storming",
  title: "購買イベント",
  nodes: [
    { id: "buyer", label: "Buyer", kind: "actor" },
    { id: "place", label: "Place order", kind: "command" },
    { id: "placed", label: "Order placed", kind: "event" },
    { id: "memo", label: "メモ", kind: "note", noteText: "未決: 在庫の引当" },
  ],
  edges: [
    { id: "e1", from: "buyer", to: "place", label: "requests" },
    { id: "e2", from: "place", to: "placed", label: "emits" },
  ],
  groups: [{ id: "lane", label: "Ordering", nodes: ["place", "placed"] }],
};

/** 生成物が書く想定の「モデルだけ」のファイルを配信時の形へ通す */
function modelOnlyPage(model: DiagramModel): string {
  const raw =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<title>${model.title ?? ""}</title></head><body>` +
    `<script type="application/json" id="ark-diagram-model">` +
    `${JSON.stringify(model)}</script></body></html>`;
  return injectHarness(injectBuiltinProjection(raw, model));
}

async function openBuiltin(page: Page, model: DiagramModel) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(modelOnlyPage(model));
  await expect(page.locator(".ark-harness-graph-node").first()).toBeVisible();
}

async function connectSubmissionPort(page: Page) {
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      arkHarnessSubmission?: unknown;
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      if (event.data?.type === "ark:diagram-autosave") {
        channel.port1.postMessage({
          type: "ark:diagram-autosave-result",
          ok: true,
        });
      } else {
        browserWindow.arkHarnessSubmission = event.data;
      }
    };
    window.postMessage({ type: "ark:test-connect" }, "*", [channel.port2]);
  });
  await expect(
    page.getByRole("button", {
      name: "変更を親フレームへ送信する",
      includeHidden: true,
    })
  ).toBeEnabled();
}

async function submitAndRead(page: Page) {
  await page
    .getByRole("button", { name: "変更を親フレームへ送信する" })
    .click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel; html: string };
        }
      ).arkHarnessSubmission
  );
}

test("er: モデルだけのファイルから entity・field・group・多重度を描画する", async ({
  page,
}) => {
  await openBuiltin(page, erModel);

  // node と field
  await expect(
    page.locator('article[data-model-id="customer"][data-kind="entity"]')
  ).toBeVisible();
  await expect(
    page.locator('article[data-model-id="order"][data-kind="root"]')
  ).toBeVisible();
  await expect(page.locator('li[data-model-id="o_customer"]')).toContainText(
    "customer_id FK"
  );
  // group 境界はハーネスの geometry が解決したときだけ表示される
  await expect(
    page.locator('.ark-builtin-group[data-model-id="ordering"]')
  ).toHaveClass(/ark-harness-graph-group/);
  // edge と crow's foot（多重度）が描かれる
  await expect(
    page.locator('.ark-harness-edge-main[data-ark-edge-id="e_places"]')
  ).toHaveAttribute("data-ark-edge-type", "identifying");
  const markers = await page.locator('[data-ark-edge-id="e_places"]').count();
  expect(markers).toBeGreaterThan(1);
});

test("kind 別スタイルが label span へ漏れない", async ({ page }) => {
  // ハーネスが label span へ data-kind を同期するため、kind セレクタの
  // 書き方を誤ると破線 kind のラベルに二重枠が出る
  await openBuiltin(page, erModel);

  const labelBorder = await page
    .locator('span[data-model-id="order"]')
    .evaluate(el => getComputedStyle(el).borderTopStyle);
  expect(labelBorder).toBe("none");
});

test("er: 自動レイアウトが node を重ねずに配置する", async ({ page }) => {
  await openBuiltin(page, erModel);

  const first = await page
    .locator('article[data-model-id="customer"]')
    .boundingBox();
  const second = await page
    .locator('article[data-model-id="order"]')
    .boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (!first || !second) return;
  const overlaps =
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height;
  expect(overlaps).toBe(false);
});

/** node root の ::before に出る kind 見出し（icon + kind 名） */
async function kindHeading(page: Page, id: string): Promise<string> {
  return page
    .locator(`article[data-model-id="${id}"]`)
    .evaluate(el => getComputedStyle(el, "::before").content);
}

test("event-storming: kind 名を可視の見出しとして出し note 本文を描画する", async ({
  page,
}) => {
  await openBuiltin(page, stormingModel);

  expect(await kindHeading(page, "placed")).toContain("event");
  expect(await kindHeading(page, "buyer")).toContain("actor");
  await expect(
    page.locator('article[data-model-id="memo"] [data-ark-harness-note]')
  ).toContainText("未決: 在庫の引当");
});

test("kind を変えると可視の kind 見出しも追従する", async ({ page }) => {
  // kind 名を DOM の静的テキストで持つと、ハーネスは root の data-kind しか
  // 更新しないため表示が古いまま残る（CodeRabbit #293 の指摘・実機で再現）
  await openBuiltin(page, stormingModel);

  const node = page.locator('article[data-model-id="placed"]');
  expect(await kindHeading(page, "placed")).toContain("event");

  await node.dispatchEvent("pointerdown", { button: 0 });
  await node.dispatchEvent("click", { button: 0 });
  const toolbar = page.locator("[data-ark-selection-id]").first();
  await expect(toolbar).toHaveAttribute("data-ark-selection-id", "placed");
  await toolbar
    .locator("select.ark-harness-kind-select")
    .selectOption("command");

  await expect(node).toHaveAttribute("data-kind", "command");
  const after = await kindHeading(page, "placed");
  expect(after).toContain("command");
  expect(after).not.toContain("event");
});

test("送信 HTML は生成投影を含まずモデルだけが残る", async ({ page }) => {
  await openBuiltin(page, erModel);
  await connectSubmissionPort(page);

  // ラベルを編集してから送る（編集が効くことも同時に確認する）
  await page.locator('span[data-model-id="order"]').fill("受注");
  const submission = await submitAndRead(page);

  expect(submission?.model.nodes.find(n => n.id === "order")?.label).toBe(
    "受注"
  );
  expect(submission?.model.type).toBe("er");
  // 生成した DOM・CSS はファイルへ焼き付かない
  expect(submission?.html).not.toContain('data-ark-container="graph"');
  expect(submission?.html).not.toContain("ark-builtin-node");
  expect(submission?.html).not.toContain("ark-builtin-title");
  expect(submission?.html).not.toContain("--ark-harness-group-x");
  // モデルブロックは残る
  expect(submission?.html).toContain("ark-diagram-model");
});

test("パレットで追加した node も内蔵の kind 見出しを持つ", async ({ page }) => {
  // 見出しを node root の ::before で出すので、ハーネスが作った DOM でも
  // class と data-kind さえ揃えば同じ装飾になる
  await openBuiltin(page, stormingModel);

  const source = page.locator('article[data-model-id="place"]');
  await source.dispatchEvent("pointerdown", { button: 0 });
  await source.dispatchEvent("click", { button: 0 });
  const toolbar = page.locator("[data-ark-selection-id]").first();
  await toolbar.locator("select.ark-harness-kind-select").selectOption("event");

  const box = await source.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // 下辺の anchor から空白へ drag して node を追加する
  await page.mouse.move(box.x + box.width / 2, box.y + box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 260, {
    steps: 12,
  });
  await page.mouse.up();

  const added = page.locator('article[data-kind="event"]').last();
  await expect(added).toHaveClass(/ark-builtin-node/);
  const heading = await added.evaluate(
    el => getComputedStyle(el, "::before").content
  );
  expect(heading).toContain("event");
});

test("生成投影の図でも node を drag して座標をモデルへ保存できる", async ({
  page,
}) => {
  await openBuiltin(page, erModel);
  await connectSubmissionPort(page);

  const node = page.locator('article[data-model-id="customer"]');
  const before = await node.boundingBox();
  expect(before).not.toBeNull();
  if (!before) return;
  await page.mouse.move(before.x + 20, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 200, before.y + 160, { steps: 12 });
  await page.mouse.up();

  const submission = await submitAndRead(page);
  const moved = submission?.model.nodes.find(n => n.id === "customer");
  expect(Number.isFinite(moved?.ext?.x as number)).toBe(true);
  expect(Number.isFinite(moved?.ext?.y as number)).toBe(true);
});
