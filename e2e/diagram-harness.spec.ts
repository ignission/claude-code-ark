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

async function openDiagram(page: Page, diagramModel: unknown = model) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(diagramHtml(diagramModel));
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
  await expect(graph.locator('[data-ark-edge-id="e_order_user"]')).toHaveCount(
    1
  );
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
  await expect(graph.locator('[data-ark-edge-id="e_order_user"]')).toHaveCount(
    1
  );
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
  await expect(graph.locator("[data-ark-edge-id]")).toHaveCount(
    diagramModel.edges.length
  );
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
  await expect(graph.locator("[data-ark-edge-id]")).toHaveCount(
    diagramModel.edges.length
  );
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
