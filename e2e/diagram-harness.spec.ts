import { expect, type Locator, type Page, test } from "@playwright/test";
import { injectHarness } from "../packages/server/src/lib/diagram-harness";

const model = {
  version: 1,
  nodes: [
    {
      id: "order",
      label: "Order",
      kind: "aggregate",
      fields: [
        { id: "order_id", label: "id" },
        { id: "order_status", label: "status" },
      ],
      ext: { x: 40, y: 50 },
    },
    {
      id: "user",
      label: "User",
      kind: "entity",
      fields: [{ id: "user_id", label: "id" }],
      ext: { x: 360, y: 180 },
    },
  ],
  edges: [
    { id: "e_order_user", from: "order", to: "user", label: "belongs to" },
  ],
  groups: [],
};

function diagramHtml(diagramModel: unknown = model): string {
  return injectHarness(`<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; }
      .graph { width: 720px; height: 480px; background: #f8fafc; }
      .entity { box-sizing: border-box; width: 220px; padding: 12px; border: 1px solid #64748b; border-left: 4px solid var(--kind-color); background: var(--kind-bg); }
      [data-kind="aggregate"] { --kind-color: #e0af68; --kind-bg: #332b1f; }
      [data-kind="entity"] { --kind-color: #7aa2f7; --kind-bg: #1f2a44; }
      [data-kind="event"] { --kind-color: #9ece6a; --kind-bg: #203222; }
      [data-kind="aggregate"] .kind-icon::before { content: "◆"; }
      [data-kind="entity"] .kind-icon::before { content: "●"; }
      [data-kind="event"] .kind-icon::before { content: "⚡"; }
    </style>
  </head>
  <body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(diagramModel)}</script>
    <div class="graph" data-ark-container="graph">
      <section class="entity" data-model-id="order">
        <h2 data-model-id="order"><span class="kind-icon" aria-hidden="true"></span>Order</h2>
        <ul>
          <li data-model-id="order_id">id</li>
          <li data-model-id="order_status">status</li>
        </ul>
      </section>
      <section class="entity" data-model-id="user">
        <h2 data-model-id="user"><span class="kind-icon" aria-hidden="true"></span>User</h2>
        <ul><li data-model-id="user_id">id</li></ul>
      </section>
    </div>
  </body>
</html>`);
}

function invalidCoordinateHtml(): string {
  const invalidModel = {
    version: 1,
    nodes: [
      { id: "valid_a", label: "Valid A", ext: { x: 40, y: 50 } },
      { id: "valid_b", label: "Valid B", ext: { x: 360, y: 180 } },
      { id: "string_x", label: "String X", ext: { x: "40", y: 80 } },
      { id: "null_y", label: "Null Y", ext: { x: 80, y: null } },
      { id: "outside", label: "Outside", ext: { x: 10, y: 10 } },
    ],
    edges: [
      { id: "valid_edge", from: "valid_a", to: "valid_b" },
      { id: "invalid_coordinate_edge", from: "valid_a", to: "string_x" },
      { id: "outside_edge", from: "valid_a", to: "outside" },
    ],
    groups: [],
  };
  return injectHarness(`<!doctype html><html><head><style>
    body { margin: 0; }
    .graph { width: 720px; height: 480px; }
    .node { width: 160px; height: 80px; }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(invalidModel)}</script>
    <div class="graph" data-ark-container="graph">
      <section class="node" data-model-id="valid_a">Valid A</section>
      <section class="node" data-model-id="valid_b">Valid B</section>
      <section class="node" data-model-id="string_x">String X</section>
      <section class="node" data-model-id="null_y">Null Y</section>
    </div>
    <section data-model-id="outside">Outside</section>
  </body></html>`);
}

async function openDiagram(page: Page, diagramModel: unknown = model) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(diagramHtml(diagramModel));
  return errors;
}

async function connectSubmissionPort(page: Page) {
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      arkHarnessSubmission?: unknown;
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      browserWindow.arkHarnessSubmission = event.data;
    };
    window.postMessage({ type: "ark:test-connect" }, "*", [channel.port2]);
  });
  await expect(
    page.getByRole("button", { name: "変更を親フレームへ送信する" })
  ).toBeEnabled();
}

async function readEdge(page: Page) {
  return page.locator('[data-ark-edge-id="e_order_user"]').evaluate(line => {
    const svg = line.ownerSVGElement;
    if (!svg) throw new Error("edge SVG がありません");
    const svgRect = svg.getBoundingClientRect();
    return {
      x1: svgRect.x + Number(line.getAttribute("x1")),
      y1: svgRect.y + Number(line.getAttribute("y1")),
      x2: svgRect.x + Number(line.getAttribute("x2")),
      y2: svgRect.y + Number(line.getAttribute("y2")),
    };
  });
}

async function requiredBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("要素の bounding box がありません");
  return box;
}

test("ext 座標の2次元配置と edge で node 外周を結ぶ", async ({ page }) => {
  await openDiagram(page);

  const graph = page.locator('[data-ark-container="graph"]');
  const order = graph.locator('section[data-model-id="order"]');
  const user = graph.locator('section[data-model-id="user"]');
  await expect(graph.locator(".ark-harness-edge-layer")).toHaveCount(1);
  const [graphBox, orderBox, userBox] = await Promise.all([
    requiredBoundingBox(graph),
    requiredBoundingBox(order),
    requiredBoundingBox(user),
  ]);
  expect(orderBox.x - graphBox.x).toBeCloseTo(40, 0);
  expect(orderBox.y - graphBox.y).toBeCloseTo(50, 0);
  expect(userBox.x - graphBox.x).toBeCloseTo(360, 0);
  expect(userBox.y - graphBox.y).toBeCloseTo(180, 0);

  const edge = graph.locator('[data-ark-edge-id="e_order_user"]');
  await expect(edge).toHaveCount(1);
  await expect(graph.locator("text", { hasText: "belongs to" })).toHaveCount(1);
  await expect(
    page.getByText("Order — belongs to → User", { exact: true })
  ).toHaveCount(0);

  const line = await readEdge(page);
  const pointIsOnPerimeter = (x: number, y: number, box: typeof orderBox) => {
    const inX = x >= box.x - 1 && x <= box.x + box.width + 1;
    const inY = y >= box.y - 1 && y <= box.y + box.height + 1;
    const sideDistance = Math.min(
      Math.abs(x - box.x),
      Math.abs(x - (box.x + box.width)),
      Math.abs(y - box.y),
      Math.abs(y - (box.y + box.height))
    );
    return inX && inY && sideDistance <= 1;
  };
  expect(pointIsOnPerimeter(line.x1, line.y1, orderBox)).toBe(true);
  expect(pointIsOnPerimeter(line.x2, line.y2, userBox)).toBe(true);
});

test("node.kind を data-kind へ同期して色とアイコンを区別する", async ({
  page,
}) => {
  await openDiagram(page);

  const graph = page.locator('[data-ark-container="graph"]');
  const order = graph.locator('section[data-model-id="order"]');
  const user = graph.locator('section[data-model-id="user"]');
  await expect(order).toHaveAttribute("data-kind", "aggregate");
  await expect(user).toHaveAttribute("data-kind", "entity");

  const [orderStyle, userStyle] = await Promise.all([
    order.evaluate(element => {
      const style = getComputedStyle(element);
      const icon = element.querySelector(".kind-icon");
      return {
        backgroundColor: style.backgroundColor,
        borderLeftColor: style.borderLeftColor,
        icon: icon ? getComputedStyle(icon, "::before").content : "none",
      };
    }),
    user.evaluate(element => {
      const style = getComputedStyle(element);
      const icon = element.querySelector(".kind-icon");
      return {
        backgroundColor: style.backgroundColor,
        borderLeftColor: style.borderLeftColor,
        icon: icon ? getComputedStyle(icon, "::before").content : "none",
      };
    }),
  ]);
  expect(orderStyle.backgroundColor).not.toBe(userStyle.backgroundColor);
  expect(orderStyle.borderLeftColor).not.toBe(userStyle.borderLeftColor);
  expect(orderStyle.icon).not.toBe("none");
  expect(orderStyle.icon).not.toBe("");
  expect(userStyle.icon).not.toBe("none");
  expect(userStyle.icon).not.toBe("");
  expect(orderStyle.icon).not.toBe(userStyle.icon);

  await expect(graph.locator(".ark-harness-edge-layer")).toHaveCount(1);
  await expect(graph.locator('[data-ark-edge-id="e_order_user"]')).toHaveCount(
    1
  );
  await expect(
    order.locator('li[data-model-id="order_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
  await expect(
    user.locator('li[data-model-id="user_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
});

test("node ドラッグと list 編集を送信 model と clean HTML に反映する", async ({
  page,
}) => {
  await openDiagram(page);
  await connectSubmissionPort(page);

  const order = page.locator('section[data-model-id="order"]');
  const handle = order.locator(".ark-harness-graph-handle");
  const beforeBox = await requiredBoundingBox(order);
  const beforeEdge = await readEdge(page);
  const handleBox = await requiredBoundingBox(handle);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 80,
    handleBox.y + handleBox.height / 2 + 60
  );
  await page.mouse.up();

  await expect
    .poll(async () => (await order.boundingBox())?.x)
    .toBeCloseTo(beforeBox.x + 80, 0);
  const afterBox = await requiredBoundingBox(order);
  const afterEdge = await readEdge(page);
  expect(afterBox.y).toBeCloseTo(beforeBox.y + 60, 0);
  expect(afterEdge.x1 - beforeEdge.x1).toBeCloseTo(80, 0);
  expect(afterEdge.y1).not.toBeCloseTo(beforeEdge.y1, 0);
  expect(afterEdge.x1).toBeCloseTo(afterBox.x + afterBox.width, 0);
  expect(afterEdge.y1).toBeGreaterThanOrEqual(afterBox.y);
  expect(afterEdge.y1).toBeLessThanOrEqual(afterBox.y + afterBox.height);

  const status = page.locator('li[data-model-id="order_status"]');
  await expect(status.locator(".ark-harness-text")).toHaveAttribute(
    "contenteditable",
    "true"
  );
  await status.locator(".ark-harness-text").fill("state");
  await status
    .getByRole("button", { name: "ドラッグして並べ替え" })
    .dragTo(page.locator('li[data-model-id="order_id"]'), {
      targetPosition: { x: 10, y: 1 },
    });

  await page
    .getByRole("button", { name: "変更を親フレームへ送信する" })
    .click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const submission = await page.evaluate(
    () =>
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
  );
  expect(submission).toMatchObject({
    type: "ark:diagram-submit",
    model: {
      nodes: [
        {
          id: "order",
          ext: { x: 120, y: 110 },
          fields: [
            { id: "order_status", label: "state" },
            { id: "order_id", label: "id" },
          ],
        },
        { id: "user" },
      ],
    },
  });
  const html = (submission as { html: string }).html;
  expect(html).not.toContain("ark-harness-edge-layer");
  expect(html).not.toContain("ark-harness-graph-handle");
  expect(html).not.toContain("--ark-harness-graph-x");
  expect(html).not.toContain("--ark-harness-graph-y");
  expect(html).toContain('data-ark-container="graph"');
});

test("モデル直接編集後の kind 再同期と node ドラッグを送信 model に反映する", async ({
  page,
}) => {
  await openDiagram(page);
  await connectSubmissionPort(page);

  const editedModel = {
    ...model,
    nodes: model.nodes.map(node =>
      node.id === "order"
        ? { ...node, label: "Edited Order", kind: "event" }
        : node
    ),
  };
  const order = page.locator('section[data-model-id="order"]');
  const beforeStyle = await order.evaluate(element => {
    const icon = element.querySelector(".kind-icon");
    return {
      backgroundColor: getComputedStyle(element).backgroundColor,
      borderLeftColor: getComputedStyle(element).borderLeftColor,
      icon: icon ? getComputedStyle(icon, "::before").content : "none",
    };
  });
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  await page.locator(".ark-harness-textarea").fill(JSON.stringify(editedModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();

  await expect(order).toHaveAttribute("data-kind", "event");
  const afterStyle = await order.evaluate(element => {
    const icon = element.querySelector(".kind-icon");
    return {
      backgroundColor: getComputedStyle(element).backgroundColor,
      borderLeftColor: getComputedStyle(element).borderLeftColor,
      icon: icon ? getComputedStyle(icon, "::before").content : "none",
    };
  });
  expect(afterStyle.backgroundColor).not.toBe(beforeStyle.backgroundColor);
  expect(afterStyle.borderLeftColor).not.toBe(beforeStyle.borderLeftColor);
  expect(afterStyle.icon).not.toBe("none");
  expect(afterStyle.icon).not.toBe("");
  expect(afterStyle.icon).not.toBe(beforeStyle.icon);

  const handleBox = await requiredBoundingBox(
    order.locator(".ark-harness-graph-handle")
  );
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 80,
    handleBox.y + handleBox.height / 2 + 60
  );
  await page.mouse.up();

  await page
    .getByRole("button", { name: "変更を親フレームへ送信する" })
    .click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const submission = await page.evaluate(
    () =>
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
  );
  expect(submission).toMatchObject({
    type: "ark:diagram-submit",
    model: {
      nodes: [
        {
          id: "order",
          label: "Edited Order",
          kind: "event",
          ext: { x: 120, y: 110 },
        },
        { id: "user" },
      ],
    },
  });
  const html = (submission as { html: string }).html;
  expect(html).toContain('data-kind="event"');
  expect(html).not.toContain("ark-harness-edge-layer");
  expect(html).not.toContain("ark-harness-graph-handle");
  expect(html).not.toContain("--ark-harness-graph-x");
  expect(html).not.toContain("--ark-harness-graph-y");
});

test("不正座標と graph 外参照を安全に除外する", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(invalidCoordinateHtml());

  const graph = page.locator('[data-ark-container="graph"]');
  await expect(graph.locator('[data-ark-edge-id="valid_edge"]')).toHaveCount(1);
  await expect(
    graph.locator('[data-ark-edge-id="invalid_coordinate_edge"]')
  ).toHaveCount(0);
  await expect(graph.locator('[data-ark-edge-id="outside_edge"]')).toHaveCount(
    0
  );
  await expect(graph.locator("[data-ark-edge-id]")).toHaveCount(1);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(2);
  await expect(
    graph.locator('[data-model-id="string_x"] .ark-harness-graph-handle')
  ).toHaveCount(0);
  await expect(
    graph.locator('[data-model-id="null_y"] .ark-harness-graph-handle')
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
