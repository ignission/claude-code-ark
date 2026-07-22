import { readFileSync } from "node:fs";
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
    {
      id: "external",
      label: "External",
      ext: { x: 20, y: 20 },
    },
  ],
  edges: [
    { id: "e_order_user", from: "order", to: "user", label: "belongs to" },
  ],
  groups: [
    {
      id: "ordering-context",
      label: "Ordering Context",
      nodes: ["order", "user"],
      ext: { role: "bounded-context" },
    },
    { id: "empty-context", label: "Empty Context", nodes: [] },
    {
      id: "cross-graph-context",
      label: "Cross Graph Context",
      nodes: ["order", "external"],
    },
  ],
};

function diagramHtml(diagramModel: unknown = model): string {
  return injectHarness(`<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; }
      .graph { width: 720px; height: 480px; background: #f8fafc; }
      .entity { box-sizing: border-box; width: 220px; padding: 12px; border: 1px solid #64748b; border-left: 4px solid var(--kind-color); background: var(--kind-bg); }
      .group-boundary {
        display: none;
        box-sizing: border-box;
        position: absolute;
        left: calc(var(--ark-harness-group-x) - 20px);
        top: calc(var(--ark-harness-group-y) - 28px);
        width: calc(var(--ark-harness-group-width) + 40px);
        height: calc(var(--ark-harness-group-height) + 48px);
        border: 2px solid #0f766e;
        background: rgba(15, 118, 110, .08);
      }
      .group-boundary.ark-harness-graph-group { display: block; }
      .group-label { position: absolute; top: 4px; left: 8px; color: #134e4a; }
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
      <section class="group-boundary" data-ark-group data-model-id="ordering-context">
        <span class="group-label" data-model-id="ordering-context">Ordering Context</span>
      </section>
      <section class="group-boundary" data-ark-group data-model-id="empty-context">
        <span class="group-label" data-model-id="empty-context">Empty Context</span>
      </section>
      <section class="group-boundary" data-ark-group data-model-id="cross-graph-context">
        <span class="group-label" data-model-id="cross-graph-context">Cross Graph Context</span>
      </section>
      <section class="group-boundary" data-ark-group data-model-id="missing-context">
        <span class="group-label" data-model-id="missing-context">Missing Context</span>
      </section>
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
    <section data-model-id="external">External</section>
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

const edgeSemanticsModel = {
  version: 1,
  nodes: [
    {
      id: "order",
      label: "Order",
      kind: "entity",
      fields: [{ id: "order_id", label: "id" }],
      ext: { x: 40, y: 60 },
    },
    {
      id: "user",
      label: "User",
      kind: "entity",
      fields: [{ id: "user_id", label: "id" }],
      ext: { x: 340, y: 60 },
    },
    {
      id: "account",
      label: "Account",
      kind: "entity",
      fields: [{ id: "account_id", label: "id" }],
      ext: { x: 610, y: 260 },
    },
    { id: "outside", label: "Outside", ext: { x: 10, y: 10 } },
  ],
  edges: [
    {
      id: "e_order_owner",
      from: "order",
      to: "user",
      label: "owned by",
      ext: {
        from_card: "one",
        to_card: "zero-or-many",
        direction: "forward",
        type: "belongs-to",
      },
    },
    {
      id: "e_account_user",
      from: "order",
      to: "account",
      label: "legacy edge",
    },
  ],
  groups: [],
};

function edgeSemanticsHtml(diagramModel: unknown = edgeSemanticsModel): string {
  return injectHarness(`<!doctype html><html><head><style>
    body { margin: 0; }
    .graph { width: 860px; height: 520px; background: #f8fafc; }
    .entity { box-sizing: border-box; width: 180px; min-height: 90px; padding: 12px; border: 1px solid #64748b; background: white; }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(diagramModel)}</script>
    <div class="graph" data-ark-container="graph">
      <section class="entity" data-model-id="order"><h2 data-model-id="order">Order</h2><ul><li data-model-id="order_id">id</li></ul></section>
      <section class="entity" data-model-id="user"><h2 data-model-id="user">User</h2><ul><li data-model-id="user_id">id</li></ul></section>
      <section class="entity" data-model-id="account"><h2 data-model-id="account">Account</h2><ul><li data-model-id="account_id">id</li></ul></section>
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

async function openEdgeSemanticsDiagram(
  page: Page,
  diagramModel: unknown = edgeSemanticsModel
) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(edgeSemanticsHtml(diagramModel));
  return errors;
}

async function openAuthoredDiagram(page: Page, filename: string) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const html = readFileSync(
    new URL(`../docs/diagrams/${filename}`, import.meta.url),
    "utf8"
  );
  await page.setContent(injectHarness(html));
  return { errors, html };
}

async function openSampleDiagram(page: Page) {
  await openAuthoredDiagram(page, "sample.diagram.html");
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
  return page
    .locator('.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
    .evaluate(line => {
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

async function readNamedEdge(page: Page, edgeId: string) {
  return page
    .locator(
      `line[data-ark-edge-id="${edgeId}"], path[data-ark-edge-id="${edgeId}"]`
    )
    .first()
    .evaluate(edge => {
      const svg = edge.ownerSVGElement;
      if (!svg) throw new Error("edge SVG がありません");
      const svgRect = svg.getBoundingClientRect();
      if (edge.tagName.toLowerCase() === "line") {
        return {
          x1: svgRect.x + Number(edge.getAttribute("x1")),
          y1: svgRect.y + Number(edge.getAttribute("y1")),
          x2: svgRect.x + Number(edge.getAttribute("x2")),
          y2: svgRect.y + Number(edge.getAttribute("y2")),
        };
      }
      const path = edge as SVGPathElement;
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      return {
        x1: svgRect.x + start.x,
        y1: svgRect.y + start.y,
        x2: svgRect.x + end.x,
        y2: svgRect.y + end.y,
      };
    });
}

async function requiredBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("要素の bounding box がありません");
  return box;
}

function expectBoxToContain(
  container: { x: number; y: number; width: number; height: number },
  member: { x: number; y: number; width: number; height: number }
) {
  expect(container.x).toBeLessThanOrEqual(member.x);
  expect(container.y).toBeLessThanOrEqual(member.y);
  expect(container.x + container.width).toBeGreaterThanOrEqual(
    member.x + member.width
  );
  expect(container.y + container.height).toBeGreaterThanOrEqual(
    member.y + member.height
  );
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

  const edge = graph.locator(
    '.ark-harness-edge-main[data-ark-edge-id="e_order_user"]'
  );
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

test("cardinality・方向・type を edge SVG に安全に投影する", async ({
  page,
}) => {
  const errors = await openEdgeSemanticsDiagram(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const edge = graph.locator(
    'line[data-ark-edge-id="e_order_owner"], path[data-ark-edge-id="e_order_owner"]'
  );
  const fromCardinality = graph.locator(
    '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="from"][data-ark-edge-cardinality="one"]'
  );
  const toCardinality = graph.locator(
    '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"][data-ark-edge-cardinality="zero-or-many"]'
  );

  await expect(fromCardinality.locator("line")).toHaveCount(1);
  expect(
    await fromCardinality.locator("line").evaluate(element => ({
      length: (element as SVGLineElement).getTotalLength(),
      stroke: getComputedStyle(element).stroke,
    }))
  ).toMatchObject({ length: expect.any(Number), stroke: "rgb(100, 116, 139)" });
  await expect(toCardinality.locator("circle")).toBeVisible();
  await expect(toCardinality.locator("circle")).toHaveCount(1);
  await expect(toCardinality.locator("line")).toHaveCount(3);
  await expect(edge).toHaveAttribute("data-ark-edge-direction", "forward");
  await expect(edge).toHaveAttribute("data-ark-edge-type", "belongs-to");
  await expect(edge).not.toHaveAttribute("marker-start", /.+/);
  await expect(edge).toHaveAttribute("marker-end", /url\(.+\)/);

  const editButton = page.getByRole("button", {
    name: "モデル JSON を直接編集する",
  });
  for (const [direction, markerStart, markerEnd] of [
    ["reverse", true, false],
    ["both", true, true],
    ["none", false, false],
  ] as const) {
    const nextModel = structuredClone(edgeSemanticsModel);
    const semanticEdge = nextModel.edges.find(
      candidate => candidate.id === "e_order_owner"
    );
    if (!semanticEdge?.ext) throw new Error("semantic edge がありません");
    semanticEdge.ext.direction = direction;
    await editButton.click();
    await page.locator(".ark-harness-textarea").fill(JSON.stringify(nextModel));
    await page.getByRole("button", { name: "反映", exact: true }).click();
    if (markerStart) {
      await expect(edge).toHaveAttribute("marker-start", /url\(.+\)/);
    } else {
      await expect(edge).not.toHaveAttribute("marker-start", /.+/);
    }
    if (markerEnd) {
      await expect(edge).toHaveAttribute("marker-end", /url\(.+\)/);
    } else {
      await expect(edge).not.toHaveAttribute("marker-end", /.+/);
    }
  }

  await page.reload();
  await page.setContent(edgeSemanticsHtml());
  const legacyEdge = page.locator(
    'line[data-ark-edge-id="e_account_user"], path[data-ark-edge-id="e_account_user"]'
  );
  await expect(legacyEdge).toHaveAttribute(
    "data-ark-edge-direction",
    "forward"
  );
  await expect(legacyEdge).toHaveAttribute("marker-end", /url\(.+\)/);
  await expect(page.locator("text", { hasText: "legacy edge" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("カーディナリティ 5 語彙を self-loop にも投影する", async ({ page }) => {
  const errors = await openEdgeSemanticsDiagram(page);
  const editButton = page.getByRole("button", {
    name: "モデル JSON を直接編集する",
  });
  const cases = [
    ["one", 1, 0],
    ["many", 3, 0],
    ["zero-or-one", 1, 1],
    ["one-or-many", 4, 0],
    ["zero-or-many", 3, 1],
  ] as const;

  for (const [cardinality, lineCount, circleCount] of cases) {
    const nextModel = structuredClone(edgeSemanticsModel);
    const semanticEdge = nextModel.edges[0];
    semanticEdge.to = "order";
    semanticEdge.ext.from_card = cardinality;
    semanticEdge.ext.direction = "both";
    await editButton.click();
    await page.locator(".ark-harness-textarea").fill(JSON.stringify(nextModel));
    await page.getByRole("button", { name: "反映", exact: true }).click();

    const main = page.locator(
      'path.ark-harness-edge-main[data-ark-edge-id="e_order_owner"]'
    );
    const primitive = page.locator(
      `.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="from"][data-ark-edge-cardinality="${cardinality}"]`
    );
    await expect(main).toHaveAttribute("marker-start", /url\(.+\)/);
    await expect(main).toHaveAttribute("marker-end", /url\(.+\)/);
    await expect(primitive.locator("line")).toHaveCount(lineCount);
    await expect(primitive.locator("circle")).toHaveCount(circleCount);
  }

  expect(errors).toEqual([]);
});

test("edge 端点 handle を最前面の専用 layer に配置する", async ({ page }) => {
  await openEdgeSemanticsDiagram(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const layer = graph.locator(".ark-harness-edge-handle-layer");
  const handles = layer.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"]'
  );

  await expect(layer).toHaveAttribute("data-ark-harness-ui", "1");
  await expect(handles).toHaveCount(2);
  await expect(handles.nth(0)).toHaveAttribute("data-ark-edge-end", /from|to/);
  await expect(handles.nth(1)).toHaveAttribute("data-ark-edge-end", /from|to/);
  await expect(
    layer.locator(
      '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="from"]'
    )
  ).toHaveAttribute("aria-label", /owned by.*始点.*ドラッグ.*張り替え/);
  await expect(
    layer.locator(
      '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]'
    )
  ).toHaveAttribute("aria-label", /owned by.*終点.*ドラッグ.*張り替え/);

  expect(
    await layer.evaluate(element => getComputedStyle(element).zIndex)
  ).toBe("3");
  expect(
    await graph
      .locator(".ark-harness-edge-layer")
      .evaluate(element => getComputedStyle(element).zIndex)
  ).toBe("1");
  expect(
    await graph
      .locator('.ark-harness-graph-node[data-model-id="order"]')
      .evaluate(element => getComputedStyle(element).zIndex)
  ).toBe("2");
  expect(
    await graph
      .locator(".ark-harness-graph-handle")
      .first()
      .evaluate(element => getComputedStyle(element).zIndex)
  ).toBe("3");
});

test("edge 終点を張り替えて記号と clean HTML を同期する", async ({ page }) => {
  await openEdgeSemanticsDiagram(page);
  await connectSubmissionPort(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const account = graph.locator('[data-model-id="account"]').first();
  const toHandle = graph.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]'
  );
  const [handleBox, accountBox] = await Promise.all([
    requiredBoundingBox(toHandle),
    requiredBoundingBox(account),
  ]);
  const before = await readNamedEdge(page, "e_order_owner");

  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    accountBox.x + accountBox.width / 2,
    accountBox.y + accountBox.height / 2,
    { steps: 5 }
  );
  await expect(graph.locator(".ark-harness-edge-preview")).toBeVisible();
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toBeVisible();
  await page.mouse.up();

  await expect(graph.locator(".ark-harness-edge-preview")).toHaveCount(0);
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toHaveCount(
    0
  );
  await expect
    .poll(async () => (await readNamedEdge(page, "e_order_owner")).x2)
    .not.toBeCloseTo(before.x2, 0);
  const after = await readNamedEdge(page, "e_order_owner");
  expect(after.x2).toBeGreaterThan(accountBox.x - 2);
  expect(after.x2).toBeLessThan(accountBox.x + accountBox.width + 2);
  expect(after.y2).toBeGreaterThan(accountBox.y - 2);
  expect(after.y2).toBeLessThan(accountBox.y + accountBox.height + 2);

  const movedCardinality = graph.locator(
    '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"][data-ark-edge-cardinality="zero-or-many"]'
  );
  const movedHandle = graph.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]'
  );
  for (const locator of [movedCardinality, movedHandle]) {
    const box = await requiredBoundingBox(locator);
    expect(box.x + box.width / 2).toBeGreaterThan(accountBox.x - 32);
    expect(box.x + box.width / 2).toBeLessThan(
      accountBox.x + accountBox.width + 12
    );
    expect(box.y + box.height / 2).toBeGreaterThan(accountBox.y - 32);
    expect(box.y + box.height / 2).toBeLessThan(
      accountBox.y + accountBox.height + 12
    );
  }

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
  const submittedEdge = (
    submission as {
      model: { edges: Array<(typeof edgeSemanticsModel.edges)[number]> };
    }
  ).model.edges.find(edge => edge.id === "e_order_owner");
  expect(submittedEdge).toMatchObject({
    id: "e_order_owner",
    from: "order",
    to: "account",
    ext: {
      from_card: "one",
      to_card: "zero-or-many",
      direction: "forward",
      type: "belongs-to",
    },
  });

  const html = (submission as { html: string }).html;
  expect(html).not.toContain("ark-harness-edge-handle-layer");
  expect(html).not.toContain("ark-harness-edge-handle");
  expect(html).not.toContain("ark-harness-edge-preview");
  expect(html).not.toContain("ark-harness-edge-drop-indicator");
  expect(html).not.toContain("ark-harness-edge-cardinality");
  expect(html).toContain('data-ark-container="graph"');
  expect(html).toContain('data-model-id="account"');
  expect(html).toContain('data-model-id="account_id"');
});

test("edge 始点の張り替えと self-edge を同じ handle 機構で扱う", async ({
  page,
}) => {
  const errors = await openEdgeSemanticsDiagram(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const dragEndToAccount = async (end: "from" | "to") => {
    const accountBox = await requiredBoundingBox(
      graph.locator('.ark-harness-graph-node[data-model-id="account"]')
    );
    const handle = graph.locator(
      `.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="${end}"]`
    );
    const box = await requiredBoundingBox(handle);
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementsFromPoint(x, y)
          .slice(0, 4)
          .map(element => ({
            className: element.getAttribute("class"),
            edgeId: element.getAttribute("data-ark-edge-id"),
            edgeEnd: element.getAttribute("data-ark-edge-end"),
          })),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    );
    expect(hit[0]).toMatchObject({
      className: expect.stringContaining("ark-harness-edge-handle"),
      edgeId: "e_order_owner",
      edgeEnd: end,
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(errors).toEqual([]);
    await expect(graph.locator(".ark-harness-edge-preview")).toBeVisible();
    await page.mouse.move(
      accountBox.x + accountBox.width / 2,
      accountBox.y + accountBox.height / 2,
      { steps: 4 }
    );
    await expect(
      graph.locator(".ark-harness-edge-drop-indicator")
    ).toBeVisible();
    await page.mouse.up();
  };

  await dragEndToAccount("from");
  await expect(
    graph.locator(
      'line.ark-harness-edge-main[data-ark-edge-id="e_order_owner"]'
    )
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  const rewiredFromModel = JSON.parse(
    await page.locator(".ark-harness-textarea").inputValue()
  ) as typeof edgeSemanticsModel;
  expect(rewiredFromModel.edges[0]).toMatchObject({
    from: "account",
    to: "user",
  });

  await page.goto("about:blank");
  const selfEdgeStartModel = structuredClone(edgeSemanticsModel);
  selfEdgeStartModel.edges[0].from = "account";
  await openEdgeSemanticsDiagram(page, selfEdgeStartModel);
  await dragEndToAccount("to");
  await expect(
    graph.locator(
      'path.ark-harness-edge-main[data-ark-edge-id="e_order_owner"]'
    )
  ).toHaveCount(1);
  await expect(
    graph.locator(
      '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"]'
    )
  ).toHaveCount(2);

  await connectSubmissionPort(page);
  await expect(
    graph.locator('.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"]')
  ).toHaveCount(2);

  await page
    .getByRole("button", { name: "変更を親フレームへ送信する" })
    .click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const submittedEdge = await page.evaluate(() => {
    const submission = (
      window as typeof window & {
        arkHarnessSubmission?: {
          model: { edges: Array<Record<string, unknown>> };
        };
      }
    ).arkHarnessSubmission;
    return submission?.model.edges.find(edge => edge.id === "e_order_owner");
  });
  expect(submittedEdge).toMatchObject({
    from: "account",
    to: "account",
    ext: edgeSemanticsModel.edges[0].ext,
  });
});

test("端点 drag 中の model 直接削除でも stale edge を更新しない", async ({
  page,
}) => {
  const errors = await openEdgeSemanticsDiagram(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const handle = graph.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]'
  );
  const handleBox = await requiredBoundingBox(handle);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 80, handleBox.y + 100);
  await expect(graph.locator(".ark-harness-edge-preview")).toBeVisible();

  const withoutDraggedEdge = {
    ...edgeSemanticsModel,
    edges: edgeSemanticsModel.edges.filter(edge => edge.id !== "e_order_owner"),
  };
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .evaluate(element => (element as HTMLButtonElement).click());
  await page
    .locator(".ark-harness-textarea")
    .fill(JSON.stringify(withoutDraggedEdge));
  await page
    .getByRole("button", { name: "反映", exact: true })
    .evaluate(element => (element as HTMLButtonElement).click());
  await expect(
    graph.locator('.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"]')
  ).toHaveCount(0);
  await page.mouse.up();

  await expect(graph.locator(".ark-harness-edge-preview")).toHaveCount(0);
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toHaveCount(
    0
  );
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="e_account_user"]')
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("edge 端点の invalid drop と pointercancel は model を変更しない", async ({
  page,
}) => {
  await openEdgeSemanticsDiagram(page);
  await connectSubmissionPort(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const graphBox = await requiredBoundingBox(graph);
  const outside = page.locator('body > [data-model-id="outside"]');
  const outsideBox = await requiredBoundingBox(outside);
  const handleSelector =
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]';

  for (const target of [
    { x: graphBox.x + 820, y: graphBox.y + 30 },
    {
      x: outsideBox.x + outsideBox.width / 2,
      y: outsideBox.y + outsideBox.height / 2,
    },
  ]) {
    const handleBox = await requiredBoundingBox(graph.locator(handleSelector));
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await page.mouse.up();
  }

  const handle = graph.locator(handleSelector);
  const cancelBox = await requiredBoundingBox(handle);
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2,
    cancelBox.y + cancelBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(graphBox.x + 700, graphBox.y + 400);
  await handle.dispatchEvent("pointercancel", { pointerId: 1 });
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
  const submittedEdge = await page.evaluate(() => {
    const submission = (
      window as typeof window & {
        arkHarnessSubmission?: {
          model: { edges: Array<{ id: string; from: string; to: string }> };
        };
      }
    ).arkHarnessSubmission;
    return submission?.model.edges.find(edge => edge.id === "e_order_owner");
  });
  expect(submittedEdge).toMatchObject({ from: "order", to: "user" });
  await expect(graph.locator(".ark-harness-edge-preview")).toHaveCount(0);
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toHaveCount(
    0
  );
});

test("group は複数 node を囲むラベル付き境界として投影する", async ({
  page,
}) => {
  await openDiagram(page);

  const graph = page.locator('[data-ark-container="graph"]');
  const group = graph.locator(
    '[data-ark-group][data-model-id="ordering-context"]'
  );
  const order = graph.locator('section[data-model-id="order"]');
  const user = graph.locator('section[data-model-id="user"]');

  await expect(group).toHaveClass(/ark-harness-graph-group/);
  const geometry = await group.evaluate(element => {
    const style = (element as HTMLElement).style;
    return [
      "--ark-harness-group-x",
      "--ark-harness-group-y",
      "--ark-harness-group-width",
      "--ark-harness-group-height",
    ].map(name => style.getPropertyValue(name));
  });
  for (const value of geometry) {
    expect(value).toMatch(/^-?\d+(?:\.\d+)?px$/);
    expect(Number.isFinite(Number.parseFloat(value))).toBe(true);
  }

  const [groupBox, orderBox, userBox] = await Promise.all([
    requiredBoundingBox(group),
    requiredBoundingBox(order),
    requiredBoundingBox(user),
  ]);
  expectBoxToContain(groupBox, orderBox);
  expectBoxToContain(groupBox, userBox);
  expect(groupBox.x).toBeLessThan(orderBox.x);
  expect(groupBox.y).toBeLessThan(orderBox.y);

  const label = group.locator('.group-label[data-model-id="ordering-context"]');
  await expect(label).toBeVisible();
  await expect(label).toHaveText("Ordering Context");
  await expect(label).toHaveAttribute("contenteditable", "true");
  await expect(graph.locator(".ark-harness-edge-layer")).toHaveCount(1);
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
  ).toHaveCount(1);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(2);
  await expect(
    order.locator('li[data-model-id="order_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
});

test("node ドラッグで group 境界と edge だけが追従する", async ({ page }) => {
  await openDiagram(page);

  const graph = page.locator('[data-ark-container="graph"]');
  const group = graph.locator(
    '[data-ark-group][data-model-id="ordering-context"]'
  );
  const order = graph.locator('section[data-model-id="order"]');
  const user = graph.locator('section[data-model-id="user"]');
  const beforeGroup = await requiredBoundingBox(group);
  const beforeOrder = await requiredBoundingBox(order);
  const beforeUser = await requiredBoundingBox(user);
  const beforeEdge = await readEdge(page);
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

  await expect
    .poll(async () => (await order.boundingBox())?.x)
    .toBeCloseTo(beforeOrder.x + 80, 0);
  const [afterGroup, afterOrder, afterUser, afterEdge] = await Promise.all([
    requiredBoundingBox(group),
    requiredBoundingBox(order),
    requiredBoundingBox(user),
    readEdge(page),
  ]);
  expectBoxToContain(afterGroup, afterOrder);
  expectBoxToContain(afterGroup, afterUser);
  expect(afterGroup.x).not.toBeCloseTo(beforeGroup.x, 0);
  expect(afterUser.x).toBeCloseTo(beforeUser.x, 0);
  expect(afterUser.y).toBeCloseTo(beforeUser.y, 0);
  expect(afterEdge.x1).not.toBeCloseTo(beforeEdge.x1, 0);
});

test("invalid / cross-graph group 境界を安全に除外する", async ({ page }) => {
  const errors = await openDiagram(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const invalidGroups = graph.locator(
    '[data-ark-group][data-model-id]:not([data-model-id="ordering-context"])'
  );

  await expect(invalidGroups).toHaveCount(3);
  for (const group of await invalidGroups.all()) {
    await expect(group).not.toHaveClass(/ark-harness-graph-group/);
    const geometry = await group.evaluate(element =>
      (element.getAttribute("style") || "").includes("--ark-harness-group-")
    );
    expect(geometry).toBe(false);
  }

  const orderingGroup = graph.locator(
    '[data-ark-group][data-model-id="ordering-context"]'
  );
  await expect(orderingGroup).toHaveClass(/ark-harness-graph-group/);
  const invalidatedModel = {
    ...model,
    groups: model.groups.map(group =>
      group.id === "ordering-context"
        ? { ...group, nodes: ["order", "external"] }
        : group
    ),
  };
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  await page
    .locator(".ark-harness-textarea")
    .fill(JSON.stringify(invalidatedModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();

  await expect(orderingGroup).not.toHaveClass(/ark-harness-graph-group/);
  const staleGeometry = await orderingGroup.evaluate(element =>
    (element.getAttribute("style") || "").includes("--ark-harness-group-")
  );
  expect(staleGeometry).toBe(false);
  expect(errors).toEqual([]);
});

test("group label 編集を model に反映し clean HTML から境界 geometry を除く", async ({
  page,
}) => {
  await openDiagram(page);
  await connectSubmissionPort(page);

  const label = page.locator(
    '[data-ark-group][data-model-id="ordering-context"] .group-label'
  );
  await label.fill("Orders & Users");
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

  expect(submission).toMatchObject({ type: "ark:diagram-submit" });
  const submittedGroups = (
    submission as {
      model: { groups: Array<{ id: string; label: string; nodes: string[] }> };
    }
  ).model.groups;
  expect(submittedGroups[0]).toMatchObject({
    id: "ordering-context",
    label: "Orders & Users",
    nodes: ["order", "user"],
  });
  const html = (submission as { html: string }).html;
  const cleanProjection = await page.evaluate(cleanHtml => {
    const document = new DOMParser().parseFromString(cleanHtml, "text/html");
    const group = document.querySelector(
      '[data-ark-group][data-model-id="ordering-context"]'
    );
    return {
      groupHtml: group?.outerHTML || "",
      groupClass: group?.getAttribute("class") || "",
      groupStyle: group?.getAttribute("style") || "",
      hasGraph: Boolean(document.querySelector('[data-ark-container="graph"]')),
    };
  }, html);
  expect(cleanProjection.groupClass).toBe("group-boundary");
  expect(cleanProjection.groupStyle).not.toContain("--ark-harness-group-x");
  expect(cleanProjection.groupStyle).not.toContain("--ark-harness-group-y");
  expect(cleanProjection.groupStyle).not.toContain("--ark-harness-group-width");
  expect(cleanProjection.groupStyle).not.toContain(
    "--ark-harness-group-height"
  );
  expect(cleanProjection.groupHtml).toContain('data-ark-group=""');
  expect(cleanProjection.groupHtml).toContain('class="group-label"');
  expect(cleanProjection.groupHtml).toContain("Orders &amp; Users");
  expect(cleanProjection.hasGraph).toBe(true);
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
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
  ).toHaveCount(1);
  await expect(
    order.locator('li[data-model-id="order_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
  await expect(
    user.locator('li[data-model-id="user_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
});

test("sample は複数 kind を色とアイコンで区別する", async ({ page }) => {
  await openSampleDiagram(page);

  const modelKinds = await page
    .locator("#ark-diagram-model")
    .evaluate(element => {
      const parsed = JSON.parse(element.textContent || "") as {
        nodes: Array<{ id: string; kind?: string }>;
      };
      return Object.fromEntries(parsed.nodes.map(node => [node.id, node.kind]));
    });
  const projections = await page
    .locator(
      '[data-ark-container="graph"] > [data-model-id]:not([data-ark-group])'
    )
    .evaluateAll(elements =>
      elements.map(element => {
        const icon = element.querySelector(".kind-icon");
        const style = getComputedStyle(element);
        return {
          id: element.getAttribute("data-model-id"),
          kind: element.getAttribute("data-kind"),
          color: `${style.backgroundColor}/${style.borderLeftColor}`,
          icon: icon ? getComputedStyle(icon, "::before").content : "none",
        };
      })
    );

  expect(new Set(Object.values(modelKinds))).toHaveProperty("size", 2);
  expect(projections).toHaveLength(2);
  for (const projection of projections) {
    expect(projection.kind).toBe(modelKinds[projection.id || ""]);
    expect(projection.icon).not.toBe("none");
    expect(projection.icon).not.toBe("");
  }
  expect(new Set(projections.map(projection => projection.color)).size).toBe(2);
  expect(new Set(projections.map(projection => projection.icon)).size).toBe(2);

  const graph = page.locator('[data-ark-container="graph"]');
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
  ).toHaveCount(1);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(2);
  await expect(
    graph.locator('li[data-model-id="order_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
});

test("sample group は2 node を囲むラベル付き境界として表示する", async ({
  page,
}) => {
  await openSampleDiagram(page);

  const groups = await page.locator("#ark-diagram-model").evaluate(element => {
    const parsed = JSON.parse(element.textContent || "") as {
      groups: Array<{ id: string; label: string; nodes: string[] }>;
    };
    return parsed.groups;
  });
  expect(groups.length).toBeGreaterThanOrEqual(1);
  const sampleGroup = groups[0];
  expect(sampleGroup).toBeDefined();
  if (!sampleGroup) return;
  expect(sampleGroup.nodes).toHaveLength(2);

  const graph = page.locator('[data-ark-container="graph"]');
  const boundary = graph.locator(
    `[data-ark-group][data-model-id="${sampleGroup.id}"]`
  );
  const [boundaryBox, firstNodeBox, secondNodeBox] = await Promise.all([
    requiredBoundingBox(boundary),
    requiredBoundingBox(
      graph.locator(`[data-model-id="${sampleGroup.nodes[0]}"]`).first()
    ),
    requiredBoundingBox(
      graph.locator(`[data-model-id="${sampleGroup.nodes[1]}"]`).first()
    ),
  ]);
  expectBoxToContain(boundaryBox, firstNodeBox);
  expectBoxToContain(boundaryBox, secondNodeBox);
  await expect(boundary).toContainText(sampleGroup.label);
  await expect(boundary.locator(".group-label")).toBeVisible();
});

test("ER edge semantics artifact は記号を投影して端点を張り替えられる", async ({
  page,
}) => {
  const { errors, html } = await openAuthoredDiagram(
    page,
    "er-edge-semantics.diagram.html"
  );
  const diagramModel = await page.locator("#ark-diagram-model").evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        nodes: Array<{
          id: string;
          label: string;
          kind: string;
          fields: Array<{ id: string; label: string }>;
          ext: { x: number; y: number };
        }>;
        edges: Array<{
          id: string;
          from: string;
          to: string;
          label: string;
          ext: {
            from_card: string;
            to_card: string;
            direction: string;
            type: string;
          };
        }>;
      }
  );

  expect(diagramModel.nodes.length).toBeGreaterThanOrEqual(3);
  expect(diagramModel.nodes.every(node => node.kind === "entity")).toBe(true);
  for (const node of diagramModel.nodes) {
    expect(Number.isFinite(node.ext.x)).toBe(true);
    expect(Number.isFinite(node.ext.y)).toBe(true);
    expect(node.fields.length).toBeGreaterThan(0);
  }
  expect(
    diagramModel.edges.map(edge => `${edge.ext.from_card}->${edge.ext.to_card}`)
  ).toEqual(
    expect.arrayContaining([
      "one->zero-or-many",
      "one->zero-or-one",
      "zero-or-many->zero-or-many",
    ])
  );

  const graph = page.locator('[data-ark-container="graph"]');
  for (const node of diagramModel.nodes) {
    const projection = graph.locator(
      `:scope > [data-model-id="${node.id}"]:not([data-ark-group])`
    );
    await expect(projection).toHaveAttribute("data-kind", "entity");
    await expect(projection.locator(".entity-label")).toHaveText(node.label);
    for (const field of node.fields) {
      await expect(
        projection.locator(`li[data-model-id="${field.id}"]`)
      ).toContainText(field.label);
    }
  }
  for (const edge of diagramModel.edges) {
    const main = graph.locator(
      `.ark-harness-edge-main[data-ark-edge-id="${edge.id}"]`
    );
    await expect(main).toHaveAttribute(
      "data-ark-edge-direction",
      edge.ext.direction
    );
    await expect(main).toHaveAttribute("data-ark-edge-type", edge.ext.type);
    await expect(
      graph.locator(
        `.ark-harness-edge-cardinality[data-ark-edge-id="${edge.id}"][data-ark-edge-end="from"]`
      )
    ).toHaveAttribute("data-ark-edge-cardinality", edge.ext.from_card);
    await expect(
      graph.locator(
        `.ark-harness-edge-cardinality[data-ark-edge-id="${edge.id}"][data-ark-edge-end="to"]`
      )
    ).toHaveAttribute("data-ark-edge-cardinality", edge.ext.to_card);
    await expect(graph.locator("text", { hasText: edge.label })).toHaveCount(1);
  }

  expect(html).not.toMatch(/https?:\/\//i);
  expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
  expect(html).not.toMatch(/<script(?![^>]*type=["']application\/json["'])/i);
  expect(html).not.toMatch(/<(?:img|image)\b/i);
  expect(html).not.toMatch(/@import|@font-face/i);

  await connectSubmissionPort(page);
  const product = graph.locator(
    ':scope > [data-model-id="product"]:not([data-ark-group])'
  );
  const toHandle = graph.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_customer"][data-ark-edge-end="to"]'
  );
  const [handleBox, productBox] = await Promise.all([
    requiredBoundingBox(toHandle),
    requiredBoundingBox(product),
  ]);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    productBox.x + productBox.width / 2,
    productBox.y + productBox.height / 2,
    { steps: 5 }
  );
  await expect(graph.locator(".ark-harness-edge-preview")).toBeVisible();
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toBeVisible();
  await page.mouse.up();
  await expect
    .poll(async () => (await readNamedEdge(page, "e_order_customer")).x2)
    .toBeGreaterThan(productBox.x - 2);
  const movedEdge = await readNamedEdge(page, "e_order_customer");
  expect(movedEdge.x2).toBeLessThan(productBox.x + productBox.width + 2);
  expect(movedEdge.y2).toBeGreaterThan(productBox.y - 2);
  expect(movedEdge.y2).toBeLessThan(productBox.y + productBox.height + 2);

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
  const submittedEdge = (
    submission as {
      model: { edges: typeof diagramModel.edges };
    }
  ).model.edges.find(edge => edge.id === "e_order_customer");
  expect(submittedEdge).toMatchObject({
    from: "order",
    to: "product",
    ext: diagramModel.edges.find(edge => edge.id === "e_order_customer")?.ext,
  });
  const cleanHtml = (submission as { html: string }).html;
  expect(cleanHtml).not.toContain("ark-harness-edge-handle");
  expect(cleanHtml).not.toContain("ark-harness-edge-cardinality");
  expect(cleanHtml).toContain('data-ark-container="graph"');
  expect(cleanHtml).toContain('data-model-id="product"');
  expect(errors).toEqual([]);
});

test("infrastructure sample は kind アイコンと手動配置で接続を表示する", async ({
  page,
}) => {
  const { errors, html } = await openAuthoredDiagram(
    page,
    "infrastructure.diagram.html"
  );
  const diagramModel = await page.locator("#ark-diagram-model").evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        nodes: Array<{
          id: string;
          label: string;
          kind: string;
          ext: { x: number; y: number };
        }>;
        edges: Array<{
          id: string;
          from: string;
          to: string;
          label?: string;
        }>;
      }
  );

  expect(new Set(diagramModel.nodes.map(node => node.kind))).toEqual(
    new Set(["service", "db", "queue", "lb", "cache", "external"])
  );
  for (const node of diagramModel.nodes) {
    expect(Number.isFinite(node.ext.x)).toBe(true);
    expect(Number.isFinite(node.ext.y)).toBe(true);
  }

  const graph = page.locator('[data-ark-container="graph"]');
  const graphBox = await requiredBoundingBox(graph);
  const iconsByKind = new Map<string, string>();
  for (const node of diagramModel.nodes) {
    const projection = graph.locator(
      `:scope > [data-model-id="${node.id}"]:not([data-ark-group])`
    );
    await expect(projection).toHaveAttribute("data-kind", node.kind);
    await expect(projection.locator(".node-label")).toBeVisible();
    await expect(projection.locator(".node-label")).not.toHaveText("");
    const icon = await projection
      .locator(".kind-icon")
      .evaluate(element => getComputedStyle(element, "::before").content);
    expect(icon).not.toBe("none");
    expect(icon).not.toBe("");
    iconsByKind.set(node.kind, icon);

    const box = await requiredBoundingBox(projection);
    expect(box.x - graphBox.x).toBeCloseTo(node.ext.x, 0);
    expect(box.y - graphBox.y).toBeCloseTo(node.ext.y, 0);
  }
  expect(new Set(iconsByKind.values())).toHaveProperty("size", 6);

  expect(diagramModel.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(
    expect.arrayContaining([
      "client->public-lb",
      "public-lb->api-service",
      "api-service->orders-db",
      "api-service->jobs-queue",
      "api-service->session-cache",
      "jobs-queue->worker-service",
      "worker-service->orders-db",
    ])
  );
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(diagramModel.edges.length);
  for (const edge of diagramModel.edges) {
    expect(edge.label).toBeTruthy();
    await expect(graph.locator("text", { hasText: edge.label })).toHaveCount(1);
  }

  expect(html).not.toMatch(/https?:\/\//i);
  expect(html).not.toMatch(/\bsrc\s*=\s*["']\s*\/\//i);
  expect(html).not.toMatch(/url\(\s*["']?\s*\/\//i);
  expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/icon[- ]library/i);
  expect(html).not.toMatch(
    /<use\b[^>]*\b(?:href|xlink:href)\s*=\s*["']\s*(?!(?:#|data:))[^"']+/i
  );
  expect(errors).toEqual([]);
});

test("infrastructure sample は flat group で region / VPC / subnet を囲む", async ({
  page,
}) => {
  await openAuthoredDiagram(page, "infrastructure.diagram.html");
  const diagramModel = await page.locator("#ark-diagram-model").evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        nodes: Array<{ id: string }>;
        groups: Array<{
          id: string;
          label: string;
          nodes: string[];
          ext: { role: string };
        }>;
      }
  );
  const nodeIds = new Set(diagramModel.nodes.map(node => node.id));
  const groupIds = new Set(diagramModel.groups.map(group => group.id));
  expect(new Set(diagramModel.groups.map(group => group.ext.role))).toEqual(
    new Set(["region", "vpc", "subnet"])
  );
  for (const group of diagramModel.groups) {
    expect(group.nodes.length).toBeGreaterThan(0);
    expect(group.nodes.every(nodeId => nodeIds.has(nodeId))).toBe(true);
    expect(group.nodes.every(nodeId => !groupIds.has(nodeId))).toBe(true);
  }
  expect(
    diagramModel.groups.every(group => !group.nodes.includes("client"))
  ).toBe(true);

  const graph = page.locator('[data-ark-container="graph"]');
  const boxes = new Map<
    string,
    Awaited<ReturnType<typeof requiredBoundingBox>>
  >();
  for (const group of diagramModel.groups) {
    const boundary = graph.locator(
      `:scope > [data-ark-group][data-model-id="${group.id}"]`
    );
    await expect(boundary).toHaveClass(/ark-harness-graph-group/);
    const label = boundary.locator(".group-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(group.label);
    const boundaryBox = await requiredBoundingBox(boundary);
    boxes.set(group.id, boundaryBox);
    for (const memberId of group.nodes) {
      const memberBox = await requiredBoundingBox(
        graph.locator(
          `:scope > [data-model-id="${memberId}"]:not([data-ark-group])`
        )
      );
      expectBoxToContain(boundaryBox, memberBox);
    }
  }

  const regionBox = boxes.get("tokyo-region");
  const vpcBox = boxes.get("production-vpc");
  expect(regionBox).toBeDefined();
  expect(vpcBox).toBeDefined();
  if (!regionBox || !vpcBox) return;
  const clientBox = await requiredBoundingBox(
    graph.locator(':scope > [data-model-id="client"]:not([data-ark-group])')
  );
  const clientRight = clientBox.x + clientBox.width;
  expect(clientRight).toBeLessThan(regionBox.x);
  expect(clientRight).toBeLessThan(vpcBox.x);
  expect(regionBox.x).toBeLessThan(vpcBox.x);
  expect(regionBox.y).toBeLessThan(vpcBox.y);
  expect(regionBox.width).toBeGreaterThan(vpcBox.width);
  expect(regionBox.height).toBeGreaterThan(vpcBox.height);

  const subnetMembers = Object.fromEntries(
    diagramModel.groups
      .filter(group => group.ext.role === "subnet")
      .map(group => [group.id, group.nodes])
  );
  expect(subnetMembers).toEqual({
    "public-subnet": ["public-lb"],
    "app-subnet": ["api-service", "worker-service"],
    "data-subnet": ["orders-db", "jobs-queue", "session-cache"],
  });
});

test("event storming sample は6 kindを色・アイコン・可視ラベルで区別し因果を表示する", async ({
  page,
}) => {
  const { errors, html } = await openAuthoredDiagram(
    page,
    "event-storming.diagram.html"
  );
  const diagramModel = await page.locator("#ark-diagram-model").evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        nodes: Array<{
          id: string;
          label: string;
          kind: string;
        }>;
        edges: Array<{
          id: string;
          from: string;
          to: string;
          label?: string;
        }>;
      }
  );
  const expectedColors = {
    event: "rgb(245, 158, 11)",
    command: "rgb(96, 165, 250)",
    aggregate: "rgb(250, 204, 21)",
    policy: "rgb(192, 132, 252)",
    actor: "rgb(244, 114, 182)",
    "read-model": "rgb(74, 222, 128)",
  };

  expect(new Set(diagramModel.nodes.map(node => node.kind))).toEqual(
    new Set(Object.keys(expectedColors))
  );

  const graph = page.locator('[data-ark-container="graph"]');
  const iconsByKind = new Map<string, string>();
  for (const node of diagramModel.nodes) {
    const projection = graph.locator(
      `:scope > [data-model-id="${node.id}"]:not([data-ark-group])`
    );
    await expect(projection).toHaveAttribute("data-kind", node.kind);
    await expect(projection.locator(".kind-name")).toBeVisible();
    await expect(projection.locator(".kind-name")).not.toHaveText("");
    await expect(projection.locator(".node-label")).toBeVisible();
    await expect(projection.locator(".node-label")).toHaveText(node.label);
    const style = await projection.evaluate(element => ({
      color: getComputedStyle(element).borderLeftColor,
      icon: getComputedStyle(element.querySelector(".kind-icon"), "::before")
        .content,
    }));
    expect(style.color).toBe(
      expectedColors[node.kind as keyof typeof expectedColors]
    );
    expect(style.icon).not.toBe("none");
    expect(style.icon).not.toBe("");
    iconsByKind.set(node.kind, style.icon);
  }
  expect(new Set(iconsByKind.values())).toHaveProperty("size", 6);

  expect(diagramModel.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual([
    "customer->place-order",
    "place-order->order",
    "order->order-placed",
    "order-placed->capture-payment-policy",
    "capture-payment-policy->capture-payment",
    "capture-payment->payment",
    "payment->payment-captured",
    "payment-captured->order-status",
  ]);
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(diagramModel.edges.length);
  for (const edge of diagramModel.edges) {
    expect(edge.label).toBeTruthy();
    await expect(graph.locator("text", { hasText: edge.label })).toHaveCount(1);
  }

  expect(html).not.toMatch(/https?:\/\//i);
  expect(html).not.toMatch(/\bsrc\s*=\s*["']\s*\/\//i);
  expect(html).not.toMatch(/url\(\s*["']?\s*\/\//i);
  expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/icon[- ]library/i);
  expect(html).not.toMatch(
    /<use\b[^>]*\b(?:href|xlink:href)\s*=\s*["']\s*(?!(?:#|data:))[^"']+/i
  );
  expect(errors).toEqual([]);
});

test("event storming sample は手動 timeline と flat group swimlane で配置する", async ({
  page,
}) => {
  await openAuthoredDiagram(page, "event-storming.diagram.html");
  const diagramModel = await page.locator("#ark-diagram-model").evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        nodes: Array<{
          id: string;
          ext: { x: number; y: number };
        }>;
        groups: Array<{
          id: string;
          label: string;
          nodes: string[];
          ext: { role: string; lane: string };
        }>;
      }
  );
  const causalNodeIds = [
    "customer",
    "place-order",
    "order",
    "order-placed",
    "capture-payment-policy",
    "capture-payment",
    "payment",
    "payment-captured",
    "order-status",
  ];
  const nodesById = new Map(diagramModel.nodes.map(node => [node.id, node]));
  for (const node of diagramModel.nodes) {
    expect(Number.isFinite(node.ext.x)).toBe(true);
    expect(Number.isFinite(node.ext.y)).toBe(true);
  }
  for (let index = 1; index < causalNodeIds.length; index += 1) {
    const previousNode = nodesById.get(causalNodeIds[index - 1]);
    const currentNode = nodesById.get(causalNodeIds[index]);
    expect(previousNode).toBeDefined();
    expect(currentNode).toBeDefined();
    if (!previousNode || !currentNode) continue;
    expect(currentNode.ext.x).toBeGreaterThan(previousNode.ext.x);
  }

  const graph = page.locator('[data-ark-container="graph"]');
  const graphBox = await requiredBoundingBox(graph);
  for (const node of diagramModel.nodes) {
    const projection = graph.locator(
      `:scope > [data-model-id="${node.id}"]:not([data-ark-group])`
    );
    const box = await requiredBoundingBox(projection);
    expect(box.x - graphBox.x).toBeCloseTo(node.ext.x, 0);
    expect(box.y - graphBox.y).toBeCloseTo(node.ext.y, 0);
  }
  const earlier = graph.locator(".timeline-earlier");
  const later = graph.locator(".timeline-later");
  await expect(earlier).toBeVisible();
  await expect(earlier).toHaveText("Earlier");
  await expect(later).toBeVisible();
  await expect(later).toHaveText("Later");
  const [earlierBox, laterBox] = await Promise.all([
    requiredBoundingBox(earlier),
    requiredBoundingBox(later),
  ]);
  expect(earlierBox.x).toBeLessThan(laterBox.x);

  const nodeIds = new Set(diagramModel.nodes.map(node => node.id));
  const groupIds = new Set(diagramModel.groups.map(group => group.id));
  expect(diagramModel.groups.map(group => group.label)).toEqual([
    "Customer",
    "Ordering",
    "Payment",
  ]);
  expect(
    diagramModel.groups.every(group => group.ext.role === "swimlane")
  ).toBe(true);
  const memberships = new Map(diagramModel.nodes.map(node => [node.id, 0]));
  for (const group of diagramModel.groups) {
    expect(group.nodes.length).toBeGreaterThan(0);
    expect(group.nodes.every(nodeId => nodeIds.has(nodeId))).toBe(true);
    expect(group.nodes.every(nodeId => !groupIds.has(nodeId))).toBe(true);
    for (const memberId of group.nodes) {
      memberships.set(memberId, (memberships.get(memberId) || 0) + 1);
    }
  }
  expect([...memberships.values()].every(count => count === 1)).toBe(true);

  const laneBoxes: Array<Awaited<ReturnType<typeof requiredBoundingBox>>> = [];
  for (const group of diagramModel.groups) {
    const lane = graph.locator(
      `:scope > [data-ark-group][data-model-id="${group.id}"]`
    );
    await expect(lane).toHaveClass(/ark-harness-graph-group/);
    await expect(lane).toHaveClass(/event-lane/);
    await expect(lane.locator(".group-label")).toBeVisible();
    await expect(lane.locator(".group-label")).toHaveText(group.label);
    const laneBox = await requiredBoundingBox(lane);
    laneBoxes.push(laneBox);
    expect(laneBox.x).toBeCloseTo(graphBox.x, 0);
    expect(laneBox.width).toBeCloseTo(graphBox.width, 0);
    for (const memberId of group.nodes) {
      const memberBox = await requiredBoundingBox(
        graph.locator(
          `:scope > [data-model-id="${memberId}"]:not([data-ark-group])`
        )
      );
      expectBoxToContain(laneBox, memberBox);
    }
  }
  for (let index = 1; index < laneBoxes.length; index += 1) {
    const previousLane = laneBoxes[index - 1];
    const currentLane = laneBoxes[index];
    expect(currentLane.y).toBeGreaterThanOrEqual(
      previousLane.y + previousLane.height
    );
  }
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
        { id: "external" },
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
        { id: "external" },
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
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="valid_edge"]')
  ).toHaveCount(1);
  await expect(
    graph.locator(
      '.ark-harness-edge-main[data-ark-edge-id="invalid_coordinate_edge"]'
    )
  ).toHaveCount(0);
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="outside_edge"]')
  ).toHaveCount(0);
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(1);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(2);
  await expect(
    graph.locator('[data-model-id="string_x"] .ark-harness-graph-handle')
  ).toHaveCount(0);
  await expect(
    graph.locator('[data-model-id="null_y"] .ark-harness-graph-handle')
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
