import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { describeModelDiff } from "../packages/server/src/lib/diagram-diff";
import { injectHarness } from "../packages/server/src/lib/diagram-harness";
import type { DiagramModel } from "../packages/server/src/lib/diagram-model";

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
      .entity[data-kind="event"] { width: 280px; height: 260px; }
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

function kindCandidateHtml(): string {
  const candidateModel = {
    version: 1,
    nodes: [{ id: "candidate", label: "Candidate", kind: "quoted" }],
    edges: [],
    groups: [],
  };
  return injectHarness(`<!doctype html><html><head><style>
    [data-kind="quoted"] { color: red; }
    [data-kind='single'], .variant[data-kind=unquoted] { color: green; }
    [data-kind="quoted"] { border-color: red; }
    @media (min-width: 0px) {
      [data-kind="nested"] { color: blue; }
    }
    [data-kind="escaped\\26 kind"] { color: purple; }
    .noise { --kind-like-text: "[data-kind=declaration]"; }
    /* [data-kind=comment] */
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(candidateModel)}</script>
    <div data-ark-container="graph">
      <section data-model-id="candidate">Candidate</section>
    </div>
  </body></html>`);
}

function untrustedKindHtml(): string {
  const boundaryModel = {
    version: 1,
    nodes: [
      {
        id: "unsafe",
        label: 'Unsafe "Node" <img>',
        kind: 'current"><img src=x onerror=alert(1)>',
      },
    ],
    edges: [],
    groups: [],
  };
  return injectHarness(`<!doctype html><html><head><style>
    [data-kind="candidate\\22 ><script src=x>"] { color: rgb(1, 2, 3); }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(boundaryModel)}</script>
    <div data-ark-container="graph">
      <section data-model-id="unsafe">Unsafe Node</section>
    </div>
  </body></html>`);
}

const autoLayoutNodes = [
  { id: "source", label: "Source" },
  { id: "branch_a", label: "Branch A with a wider label" },
  { id: "branch_b", label: "Branch B" },
  { id: "cycle_a", label: "Cycle A" },
  { id: "cycle_b", label: "Cycle B with two lines" },
  { id: "self", label: "Self edge" },
  { id: "isolated", label: "Isolated" },
];

const autoLayoutEdges = [
  { id: "e_source_a", from: "source", to: "branch_a" },
  { id: "e_source_b", from: "source", to: "branch_b" },
  { id: "e_a_cycle", from: "branch_a", to: "cycle_a" },
  { id: "e_cycle_ab", from: "cycle_a", to: "cycle_b" },
  { id: "e_cycle_ba", from: "cycle_b", to: "cycle_a" },
  { id: "e_self", from: "self", to: "self" },
];

function autoLayoutModel(
  layout: Record<string, unknown> = {
    direction: "LR",
    rankSpacing: 80,
    nodeSpacing: 36,
    padding: 20,
  }
): DiagramModel {
  return {
    version: 1,
    ext: { layout },
    nodes: autoLayoutNodes,
    edges: autoLayoutEdges,
    groups: [
      {
        id: "cycle_group",
        label: "Cycle Group",
        nodes: ["cycle_a", "cycle_b"],
      },
    ],
  };
}

function autoLayoutHtml(
  layout: Record<string, unknown> = {
    direction: "LR",
    rankSpacing: 80,
    nodeSpacing: 36,
    padding: 20,
  }
): string {
  const autoModel = autoLayoutModel(layout);
  return injectHarness(`<!doctype html><html><head><style>
    body { margin: 0; }
    .graph { width: 360px; height: 260px; background: #f8fafc; }
    .node { box-sizing: border-box; width: 128px; min-height: 64px; padding: 10px; border: 1px solid #64748b; background: white; }
    [data-model-id="branch_a"] { width: 196px; min-height: 82px; }
    [data-model-id="cycle_b"] { width: 148px; min-height: 104px; }
    .group-boundary {
      display: none;
      position: absolute;
      left: calc(var(--ark-harness-group-x) - 12px);
      top: calc(var(--ark-harness-group-y) - 24px);
      width: calc(var(--ark-harness-group-width) + 24px);
      height: calc(var(--ark-harness-group-height) + 36px);
      border: 2px solid #0f766e;
    }
    .group-boundary.ark-harness-graph-group { display: block; }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(autoModel)}</script>
    <div class="graph" data-ark-container="graph">
      <section class="group-boundary" data-ark-group data-model-id="cycle_group"><span data-model-id="cycle_group">Cycle Group</span></section>
      ${autoLayoutNodes
        .map(
          node =>
            `<section class="node" data-model-id="${node.id}"><h2 data-model-id="${node.id}">${node.label}</h2></section>`
        )
        .join("\n")}
    </div>
    <section data-model-id="source">Outside duplicate</section>
  </body></html>`);
}

function mixedLayoutHtml(): string {
  const mixedModel = {
    version: 1,
    ext: {
      layout: {
        direction: "LR",
        rankSpacing: 64,
        nodeSpacing: 28,
        padding: 16,
      },
    },
    nodes: [
      { id: "manual_a", label: "Manual A", ext: { x: 30, y: 40 } },
      { id: "manual_b", label: "Manual B", ext: { x: 30, y: 40 } },
      { id: "auto_missing", label: "Auto Missing" },
      { id: "auto_partial", label: "Auto Partial", ext: { x: 90 } },
      {
        id: "auto_invalid",
        label: "Auto Invalid",
        ext: { x: "120", y: 80 },
      },
    ],
    edges: [
      { id: "e_manual_auto", from: "manual_a", to: "auto_missing" },
      { id: "e_auto_partial", from: "auto_missing", to: "auto_partial" },
      { id: "e_partial_invalid", from: "auto_partial", to: "auto_invalid" },
    ],
    groups: [],
  };
  return injectHarness(`<!doctype html><html><head><style>
    body { margin: 0; }
    .graph { width: 320px; height: 220px; }
    .node { box-sizing: border-box; width: 150px; height: 72px; padding: 10px; border: 1px solid #64748b; }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(mixedModel)}</script>
    <div class="graph" data-ark-container="graph">
      ${mixedModel.nodes
        .map(
          node =>
            `<section class="node" data-model-id="${node.id}"><h2 data-model-id="${node.id}">${node.label}</h2></section>`
        )
        .join("\n")}
    </div>
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

const crudModel: DiagramModel = {
  version: 1,
  nodes: [
    {
      id: "crud-a",
      label: 'A <unsafe "node">',
      kind: "entity",
      ext: { x: 30, y: 50 },
    },
    { id: "crud-b", label: "B", kind: "entity", ext: { x: 280, y: 50 } },
    { id: "crud-d", label: "D", kind: "event" },
    {
      id: "crud-other",
      label: "Other graph",
      kind: "entity",
      ext: { x: 30, y: 30 },
    },
  ],
  edges: [
    { id: "crud-ab", from: "crud-a", to: "crud-b", label: "A to B" },
    { id: "crud-aa", from: "crud-a", to: "crud-a" },
    { id: "crud-bd", from: "crud-b", to: "crud-d" },
  ],
  groups: [
    { id: "crud-group", label: "CRUD group", nodes: ["crud-a", "crud-b"] },
  ],
  ext: {
    layout: {
      direction: "LR",
      rankSpacing: 72,
      nodeSpacing: 32,
      padding: 20,
    },
  },
};

function crudDiagramHtml(diagramModel: DiagramModel = crudModel): string {
  return injectHarness(`<!doctype html><html><head><style>
    body { margin: 0; }
    .crud-graph { width: 760px; min-height: 420px; background: #f8fafc; }
    .crud-node { box-sizing: border-box; width: 150px; min-height: 72px; padding: 12px; border: 1px solid #64748b; background: white; }
    [data-kind="entity"] { border-left: 4px solid #2563eb; }
    [data-kind="event"] { border-left: 4px solid #16a34a; }
  </style></head><body>
    <script id="ark-diagram-model" type="application/json">${JSON.stringify(diagramModel)}</script>
    <div class="crud-graph" data-ark-container="graph" data-model-id="crud-a">
      <section data-ark-group data-model-id="crud-group">CRUD group</section>
      <section class="crud-node" data-model-id="crud-a"><span data-model-id="crud-a">A unsafe node</span></section>
      <section class="crud-node" data-model-id="crud-b"><span data-model-id="crud-b">B</span></section>
      <section class="crud-node" data-model-id="crud-d"><span data-model-id="crud-d">D</span></section>
    </div>
    <div class="crud-graph" data-ark-container="graph">
      <section class="crud-node" data-model-id="crud-other"><span data-model-id="crud-other">Other graph</span></section>
    </div>
    <aside data-model-id="crud-a">duplicate projection</aside>
  </body></html>`);
}

async function readCurrentModel(page: Page): Promise<DiagramModel> {
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  const value = await page.locator(".ark-harness-textarea").inputValue();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  return JSON.parse(value) as DiagramModel;
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
    .locator('[data-ark-container="graph"]')
    .first()
    .evaluate((graph, expectedEdgeId) => {
      const edge = Array.from(
        graph.querySelectorAll("line[data-ark-edge-id], path[data-ark-edge-id]")
      ).find(
        candidate =>
          candidate.getAttribute("data-ark-edge-id") === expectedEdgeId
      );
      if (!edge) throw new Error("edge がありません");
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
    }, edgeId);
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

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
  gap = 0
) {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

async function graphNodeBoxes(page: Page) {
  const nodes = page.locator(
    '[data-ark-container="graph"] > .ark-harness-graph-node'
  );
  await expect
    .poll(() =>
      nodes.evaluateAll(elements =>
        elements.every(element =>
          Boolean(
            (element as HTMLElement).style.getPropertyValue(
              "--ark-harness-graph-x"
            )
          )
        )
      )
    )
    .toBe(true);
  return nodes.evaluateAll(elements =>
    elements.map(element => {
      const box = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-model-id") || "",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    })
  );
}

function expectNoOverlaps(
  boxes: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
  gap = 0
) {
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(
        boxesOverlap(boxes[left], boxes[right], gap),
        `${boxes[left].id} と ${boxes[right].id} が重なっています`
      ).toBe(false);
    }
  }
}

test("node CRUD: palette から安全な projection を重ならず追加して再編集できる", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(crudDiagramHtml());

  const palette = page.locator(".ark-harness-node-palette");
  await expect(palette.getByLabel("配置先")).toHaveText(/graph 1/);
  await expect(palette.getByLabel("kind")).toHaveText(/entity/);
  await expect(palette.getByLabel("kind").locator("option")).toHaveText([
    "entity",
    "event",
  ]);
  await expect(palette.locator("input")).toHaveCount(0);
  await expect(palette.getByText(/group|cardinality/i)).toHaveCount(0);

  await palette.getByLabel("配置先").selectOption("0");
  await palette.getByLabel("kind").selectOption("event");
  const initialEdgeCount = (await readCurrentModel(page)).edges.length;
  await palette.getByRole("button", { name: "ノードを追加" }).click();

  const firstGraph = page.locator('[data-ark-container="graph"]').first();
  await expect(firstGraph.locator(".ark-harness-graph-node")).toHaveCount(4);
  const current = await readCurrentModel(page);
  const added = current.nodes.find(
    node => !crudModel.nodes.some(old => old.id === node.id)
  );
  expect(added).toBeDefined();
  expect(added).toMatchObject({ label: "新しいノード", kind: "event" });
  expect(added?.id).toMatch(/^node-/);
  expect(added?.id).not.toContain("新しいノード");
  expect(Number.isInteger((added?.ext as { x?: number })?.x)).toBe(true);
  expect(Number.isInteger((added?.ext as { y?: number })?.y)).toBe(true);
  expect(current.edges).toHaveLength(initialEdgeCount);
  if (!added) throw new Error("追加 node がありません");

  const projection = firstGraph
    .locator(`[data-model-id="${added.id}"]`)
    .first();
  await expect(projection).toHaveAttribute("data-kind", "event");
  await expect(projection).toHaveClass(/crud-node/);
  await expect(
    projection.locator(`span[data-model-id="${added.id}"]`)
  ).toHaveText("新しいノード");
  await expect(projection.locator(".ark-harness-kind-picker")).toHaveCount(1);
  await expect(projection.locator(".ark-harness-graph-handle")).toHaveCount(1);
  await expect(projection.locator(".ark-harness-node-create")).toHaveCount(1);
  await expect(projection.locator(".ark-harness-node-delete")).toHaveCount(0);

  const newBox = await requiredBoundingBox(projection);
  const oldBoxes = await firstGraph
    .locator(".ark-harness-graph-node")
    .evaluateAll(
      (elements, addedId) =>
        elements
          .filter(element => element.getAttribute("data-model-id") !== addedId)
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          }),
      added.id
    );
  for (const oldBox of oldBoxes)
    expect(boxesOverlap(newBox, oldBox, 8)).toBe(false);

  await projection
    .locator(`span[data-model-id="${added.id}"]`)
    .fill("追加済み");
  expect(
    (await readCurrentModel(page)).nodes.find(node => node.id === added.id)
      ?.label
  ).toBe("追加済み");
  expect(errors).toEqual([]);
});

test("node CRUD: node 削除を対象 projection・incident edge・group 参照だけに限定する", async ({
  page,
}) => {
  await page.setContent(crudDiagramHtml());
  await connectSubmissionPort(page);
  const graphs = page.locator('[data-ark-container="graph"]');
  await expect(graphs).toHaveCount(2);
  const node = page
    .locator('[data-ark-container="graph"]')
    .first()
    .locator('[data-model-id="crud-a"]')
    .first();
  await expect(page.locator(".ark-harness-node-delete")).toHaveCount(0);
  await expect(page.locator(".ark-harness-edge-delete")).toHaveCount(0);
  await expect(page.locator(".ark-harness-edge-hit")).toHaveCount(0);
  await expect(page.locator("img, script[src], [onerror]")).toHaveCount(0);
  await node.focus();
  await expect(node).toBeFocused();
  await expect(node).toHaveClass(/ark-harness-node-selected/);
  await page.keyboard.press("Delete");

  await expect(graphs).toHaveCount(2);
  await expect(graphs.first()).toHaveAttribute("data-model-id", "crud-a");
  await expect(
    graphs.first().locator(':scope > [data-model-id="crud-a"]')
  ).toHaveCount(0);
  await expect(page.locator('aside[data-model-id="crud-a"]')).toHaveCount(0);
  await expect(
    graphs.first().locator(':scope > [data-model-id="crud-b"]')
  ).toHaveCount(1);
  await expect(
    graphs.first().locator(':scope > [data-model-id="crud-d"]')
  ).toHaveCount(1);
  await expect(
    graphs.nth(1).locator(':scope > [data-model-id="crud-other"]')
  ).toHaveCount(1);
  await expect(page.locator('[data-ark-edge-id="crud-ab"]')).toHaveCount(0);
  await expect(page.locator('[data-ark-edge-id="crud-aa"]')).toHaveCount(0);
  await expect(
    page.locator('.ark-harness-edge-main[data-ark-edge-id="crud-bd"]')
  ).toHaveCount(1);
  const current = await readCurrentModel(page);
  expect(current.nodes.some(entry => entry.id === "crud-a")).toBe(false);
  expect(current.edges.map(edge => edge.id)).toEqual(["crud-bd"]);
  expect(current.groups).toEqual([
    { id: "crud-group", label: "CRUD group", nodes: ["crud-b"] },
  ]);
  expect(describeModelDiff(crudModel, current)).toEqual([
    'A <unsafe "node"> を削除',
    'A <unsafe "node"> から B への関連「A to B」を削除',
    'A <unsafe "node"> から A <unsafe "node"> への関連を削除',
  ]);
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
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel; html: string };
        }
      ).arkHarnessSubmission
  );
  expect(submission?.model).toEqual(current);
  expect(submission?.html).toContain('data-ark-container="graph"');
  expect(submission?.html).toContain('data-model-id="crud-b"');
  expect(submission?.html).toContain('id="ark-diagram-model"');
});

test("node CRUD: contenteditable 編集中の Delete は node 削除に使わない", async ({
  page,
}) => {
  await page.setContent(crudDiagramHtml());
  const node = page
    .locator('[data-ark-container="graph"]')
    .first()
    .locator('[data-model-id="crud-a"]')
    .first();
  const editable = node.locator('span[data-model-id="crud-a"]');

  await editable.focus();
  await expect(editable).toBeFocused();
  await page.keyboard.press("Delete");

  await expect(node).toBeAttached();
  expect(
    (await readCurrentModel(page)).nodes.some(entry => entry.id === "crud-a")
  ).toBe(true);
});

test("edge CRUD: click・微小移動・source drop を無視し明確な drag だけで edge を追加する", async ({
  page,
}) => {
  await page.setContent(crudDiagramHtml());
  const graph = page.locator('[data-ark-container="graph"]').first();
  const source = graph.locator('[data-model-id="crud-b"]').first();
  const target = graph.locator('[data-model-id="crud-d"]').first();
  const otherGraphTarget = page
    .locator('[data-ark-container="graph"]')
    .nth(1)
    .locator('[data-model-id="crud-other"]')
    .first();

  const dragCreate = async (drop: Locator) => {
    await source.hover();
    const handleBox = await requiredBoundingBox(
      source.locator(".ark-harness-node-create")
    );
    const dropBox = await requiredBoundingBox(drop);
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      dropBox.x + dropBox.width / 2,
      dropBox.y + dropBox.height / 2,
      {
        steps: 5,
      }
    );
    await page.mouse.up();
  };

  const initialCount = (await readCurrentModel(page)).edges.length;
  await source.hover();
  const createHandle = source.locator(".ark-harness-node-create");
  await createHandle.click();
  expect((await readCurrentModel(page)).edges).toHaveLength(initialCount);

  let handleBox = await requiredBoundingBox(createHandle);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 3,
    handleBox.y + handleBox.height / 2 + 2
  );
  await page.mouse.up();
  expect((await readCurrentModel(page)).edges).toHaveLength(initialCount);

  handleBox = await requiredBoundingBox(createHandle);
  const sourceBox = await requiredBoundingBox(source);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  );
  await page.mouse.up();
  expect((await readCurrentModel(page)).edges).toHaveLength(initialCount);

  await dragCreate(target);
  await expect
    .poll(async () => (await readCurrentModel(page)).edges.length)
    .toBe(initialCount + 1);
  let current = await readCurrentModel(page);
  const normal = current.edges.find(
    edge => !crudModel.edges.some(old => old.id === edge.id)
  );
  expect(normal).toMatchObject({ from: "crud-b", to: "crud-d" });
  expect(normal?.id).toMatch(/^edge-/);
  expect(normal).not.toHaveProperty("label");
  expect(normal).not.toHaveProperty("ext");
  await expect(
    graph.locator(`.ark-harness-edge-handle[data-ark-edge-id="${normal?.id}"]`)
  ).toHaveCount(2);

  await source.hover();
  handleBox = await requiredBoundingBox(createHandle);
  const graphBox = await requiredBoundingBox(graph);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    graphBox.x + graphBox.width - 20,
    graphBox.y + graphBox.height - 20,
    { steps: 4 }
  );
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
    { steps: 4 }
  );
  await page.mouse.up();
  current = await readCurrentModel(page);
  const self = current.edges.find(
    edge => edge.from === "crud-b" && edge.to === "crud-b"
  );
  expect(self).toBeDefined();
  await expect(
    graph.locator(`path.ark-harness-edge-main[data-ark-edge-id="${self?.id}"]`)
  ).toHaveCount(1);

  const beforeInvalid = current.edges.length;
  await dragCreate(otherGraphTarget);
  expect((await readCurrentModel(page)).edges).toHaveLength(beforeInvalid);
  await expect(graph.locator(".ark-harness-edge-preview")).toHaveCount(0);
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toHaveCount(
    0
  );
});

test("edge CRUD: endpoint を空き領域へ drag して対象 edge だけを削除する", async ({
  page,
}) => {
  await page.setContent(crudDiagramHtml());
  const graph = page.locator('[data-ark-container="graph"]').first();
  const endpoint = graph.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="crud-ab"][data-ark-edge-end="to"]'
  );
  const [handleBox, graphBox] = await Promise.all([
    requiredBoundingBox(endpoint),
    requiredBoundingBox(graph),
  ]);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    graphBox.x + graphBox.width - 20,
    graphBox.y + graphBox.height - 24,
    { steps: 5 }
  );
  await expect(endpoint).toHaveClass(/ark-harness-edge-delete-pending/);
  await expect(endpoint).toHaveAttribute("aria-label", "離すと edge を削除");
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="crud-ab"]')
  ).toHaveClass(/ark-harness-edge-delete-pending/);
  await expect(graph.locator(".ark-harness-edge-drop-indicator")).toHaveCount(
    0
  );
  await page.mouse.up();
  await expect(graph.locator('[data-ark-edge-id="crud-ab"]')).toHaveCount(0);
  await expect(graph.locator('[data-model-id="crud-a"]').first()).toBeVisible();
  await expect(page.locator('[data-ark-container="graph"]')).toHaveCount(2);
  const afterSingleDelete = await readCurrentModel(page);
  expect(describeModelDiff(crudModel, afterSingleDelete)).toEqual([
    'A <unsafe "node"> から B への関連「A to B」を削除',
  ]);
  expect(afterSingleDelete.nodes).toEqual(crudModel.nodes);
  expect(afterSingleDelete.groups).toEqual(crudModel.groups);
  expect(afterSingleDelete.edges.map(edge => edge.id)).toEqual([
    "crud-aa",
    "crud-bd",
  ]);
});

test("構造変更: clean submission は semantic node を残し CRUD UI と見た目差分を除く", async ({
  page,
}) => {
  await page.setContent(crudDiagramHtml());
  await connectSubmissionPort(page);
  await page.locator(".ark-harness-palette-kind-select").selectOption("event");
  await page.getByRole("button", { name: "ノードを追加" }).click();
  const current = await readCurrentModel(page);
  const added = current.nodes.find(
    node => !crudModel.nodes.some(old => old.id === node.id)
  );
  if (!added) throw new Error("追加 node がありません");

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
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel; html: string };
        }
      ).arkHarnessSubmission
  );
  if (!submission) throw new Error("submission がありません");
  expect(submission.html).toContain(`data-model-id="${added.id}"`);
  expect(submission.html).toContain('data-kind="event"');
  expect(submission.html).toContain("新しいノード");
  expect(submission.html).not.toContain("data-ark-harness-ui");
  expect(submission.html).not.toContain("ark-harness-node-palette");
  expect(submission.html).not.toContain("ark-harness-node-rail");
  expect(submission.html).not.toContain("ark-harness-edge-hit");
  expect(submission.html).not.toContain("--ark-harness-graph-x");
  expect(describeModelDiff(crudModel, submission.model)).toEqual([
    "新しいノード を追加",
  ]);
});

test("レイアウト方向を LR から TB へ切り替えて再配置・保存する", async ({
  page,
}) => {
  const layout = {
    direction: "LR",
    rankSpacing: 80,
    nodeSpacing: 36,
    padding: 20,
    routing: "orthogonal",
  };
  const initialModel = autoLayoutModel(layout);
  await page.setContent(autoLayoutHtml(layout));
  await connectSubmissionPort(page);

  const toolbar = page.locator(".ark-harness-toolbar");
  const directionButton = page.getByRole("button", {
    name: "方向: LR（現在 LR。TB に切り替える）",
  });
  const editModelButton = page.getByRole("button", {
    name: "モデル JSON を直接編集する",
  });
  await expect(directionButton).toHaveText("方向: LR");
  await expect(directionButton).toHaveAttribute(
    "title",
    "方向: LR（現在 LR。TB に切り替える）"
  );
  expect(
    await toolbar
      .locator("button")
      .evaluateAll(buttons => buttons.map(button => button.textContent))
  ).toEqual(["方向: LR", "+ ノード", "モデルを直接編集", "変更を送る"]);
  expect(
    await directionButton.evaluate(
      (button, editButton) =>
        Boolean(
          button.compareDocumentPosition(editButton) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ),
      await editModelButton.elementHandle()
    )
  ).toBe(true);

  const graph = page.locator('[data-ark-container="graph"]');
  const beforeBoxes = await graphNodeBoxes(page);
  const beforeById = Object.fromEntries(beforeBoxes.map(box => [box.id, box]));
  const edgeCount = await graph
    .locator(".ark-harness-edge-main[data-ark-edge-id]")
    .count();
  const endpointHandleCount = await graph
    .locator(".ark-harness-edge-handle")
    .count();

  await directionButton.click();
  const toggledButton = page.getByRole("button", {
    name: "方向: TB（現在 TB。LR に切り替える）",
  });
  await expect(toggledButton).toHaveText("方向: TB");
  await expect(toggledButton).toHaveAttribute(
    "title",
    "方向: TB（現在 TB。LR に切り替える）"
  );
  await expect
    .poll(async () => {
      const boxes = await graphNodeBoxes(page);
      const byId = Object.fromEntries(boxes.map(box => [box.id, box]));
      return byId.branch_a.y > byId.source.y + byId.source.height;
    })
    .toBe(true);

  const afterBoxes = await graphNodeBoxes(page);
  const afterById = Object.fromEntries(afterBoxes.map(box => [box.id, box]));
  expect(afterById.branch_a.y).toBeGreaterThan(beforeById.branch_a.y);
  expectNoOverlaps(afterBoxes);
  const group = graph.locator('[data-ark-group][data-model-id="cycle_group"]');
  const [groupBox, cycleABox, cycleBBox] = await Promise.all([
    requiredBoundingBox(group),
    requiredBoundingBox(graph.locator('[data-model-id="cycle_a"]').first()),
    requiredBoundingBox(graph.locator('[data-model-id="cycle_b"]').first()),
  ]);
  expectBoxToContain(groupBox, cycleABox);
  expectBoxToContain(groupBox, cycleBBox);
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(edgeCount);
  await expect(graph.locator(".ark-harness-edge-handle")).toHaveCount(
    endpointHandleCount
  );

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
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel; html: string };
        }
      ).arkHarnessSubmission
  );
  expect(submission?.model.ext?.layout).toEqual({
    ...layout,
    direction: "TB",
  });
  if (!submission) throw new Error("submission がありません");
  expect(describeModelDiff(initialModel, submission.model)).toEqual([]);
  expect(submission.html).not.toContain("方向: TB");
  expect(submission.html).not.toContain("ark-harness-layout-direction");
  expect(submission.html).not.toContain("data-ark-harness-ui");
  expect(submission.html).toContain('data-ark-container="graph"');
  expect(submission.html).toContain('id="ark-diagram-model"');
});

test("レイアウト方向は ext 欠損を補い、モデル直接編集後も同期する", async ({
  page,
}) => {
  await page.setContent(diagramHtml());
  await connectSubmissionPort(page);
  const directionButton = page.getByRole("button", {
    name: "方向: LR（現在 LR。TB に切り替える）",
  });
  await expect(directionButton).toHaveText("方向: LR");
  await directionButton.click();
  await page
    .getByRole("button", { name: "変更を親フレームへ送信する" })
    .click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const submittedModel = await page.evaluate(
    () =>
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel };
        }
      ).arkHarnessSubmission?.model
  );
  expect(submittedModel).toEqual({
    ...model,
    ext: { layout: { direction: "TB" } },
  });

  for (const [invalidExt, expectedExt] of [
    [[], { layout: { direction: "TB" } }],
    [
      { scope: "preserved", layout: [] },
      { scope: "preserved", layout: { direction: "TB" } },
    ],
  ] as const) {
    await page.setContent(diagramHtml({ ...model, ext: invalidExt }));
    await page
      .getByRole("button", {
        name: "方向: LR（現在 LR。TB に切り替える）",
      })
      .click();
    await page
      .getByRole("button", { name: "モデル JSON を直接編集する" })
      .click();
    const currentModel = JSON.parse(
      await page.locator(".ark-harness-textarea").inputValue()
    ) as DiagramModel;
    expect(currentModel.ext).toEqual(expectedExt);
  }

  const tbModel = autoLayoutModel({
    direction: "TB",
    rankSpacing: 80,
    nodeSpacing: 36,
    padding: 20,
  });
  await page.setContent(
    autoLayoutHtml(tbModel.ext?.layout as Record<string, unknown>)
  );
  const tbButton = page.getByRole("button", {
    name: "方向: TB（現在 TB。LR に切り替える）",
  });
  await expect(tbButton).toHaveText("方向: TB");
  tbModel.ext = {
    ...tbModel.ext,
    layout: {
      ...(tbModel.ext?.layout as Record<string, unknown>),
      direction: "LR",
    },
  };
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  await page.locator(".ark-harness-textarea").fill(JSON.stringify(tbModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "方向: LR（現在 LR。TB に切り替える）",
    })
  ).toHaveText("方向: LR");
});

test("レイアウト方向 UI は graph がない文書には表示しない", async ({
  page,
}) => {
  await page.setContent(
    injectHarness(`<!doctype html><html><body>
      <script id="ark-diagram-model" type="application/json">${JSON.stringify({
        version: 1,
        nodes: [{ id: "note", label: "Note" }],
        edges: [],
        groups: [],
      })}</script>
      <p data-model-id="note">Note</p>
    </body></html>`)
  );

  await expect(
    page.getByRole("button", { name: "モデル JSON を直接編集する" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "変更を親フレームへ送信する" })
  ).toBeVisible();
  await expect(page.locator(".ark-harness-layout-direction")).toHaveCount(0);
});

test("自動配置 LR は分岐・循環・self-edge・孤立 node を決定的に配置する", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(autoLayoutHtml());

  const graph = page.locator('[data-ark-container="graph"]');
  await expect(graph.locator(":scope > .ark-harness-graph-node")).toHaveCount(
    autoLayoutNodes.length
  );
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(
    autoLayoutNodes.length
  );
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(autoLayoutEdges.length);

  const boxes = await graphNodeBoxes(page);
  expect(boxes).toHaveLength(autoLayoutNodes.length);
  expect(
    boxes.every(box =>
      [box.x, box.y, box.width, box.height].every(Number.isFinite)
    )
  ).toBe(true);
  expectNoOverlaps(boxes);
  const byId = Object.fromEntries(boxes.map(box => [box.id, box]));
  expect(
    byId.branch_a.x - (byId.source.x + byId.source.width)
  ).toBeGreaterThanOrEqual(79);
  expect(byId.branch_a.x).toBeGreaterThan(byId.source.x);
  expect(
    Math.abs(byId.branch_b.y - (byId.branch_a.y + byId.branch_a.height))
  ).toBeGreaterThanOrEqual(35);

  const group = graph.locator('[data-ark-group][data-model-id="cycle_group"]');
  await expect(group).toHaveClass(/ark-harness-graph-group/);
  const [groupBox, cycleABox, cycleBBox] = await Promise.all([
    requiredBoundingBox(group),
    requiredBoundingBox(graph.locator('[data-model-id="cycle_a"]').first()),
    requiredBoundingBox(graph.locator('[data-model-id="cycle_b"]').first()),
  ]);
  expectBoxToContain(groupBox, cycleABox);
  expectBoxToContain(groupBox, cycleBBox);
  expect(errors).toEqual([]);
});

test("自動配置 TB と不正 layout 設定は安全な fallback で重なりを避ける", async ({
  page,
}) => {
  await page.setContent(
    autoLayoutHtml({
      direction: "TB",
      rankSpacing: 80,
      nodeSpacing: 36,
      padding: 20,
    })
  );
  let boxes = await graphNodeBoxes(page);
  expectNoOverlaps(boxes);
  let byId = Object.fromEntries(boxes.map(box => [box.id, box]));
  expect(
    byId.branch_a.y - (byId.source.y + byId.source.height)
  ).toBeGreaterThanOrEqual(79);
  expect(byId.branch_b.x).not.toBeCloseTo(byId.branch_a.x, 0);

  await page.setContent(
    autoLayoutHtml({
      direction: "diagonal",
      rankSpacing: -40,
      nodeSpacing: "huge",
      padding: 1_000_000,
    })
  );
  boxes = await graphNodeBoxes(page);
  expect(boxes).toHaveLength(autoLayoutNodes.length);
  expectNoOverlaps(boxes);
  byId = Object.fromEntries(boxes.map(box => [box.id, box]));
  expect(byId.branch_a.x).toBeGreaterThan(byId.source.x);
});

test("手動座標と座標未指定 node を混在させ、manual 同士の重なりだけを保持する", async ({
  page,
}) => {
  await page.setContent(mixedLayoutHtml());
  const graph = page.locator('[data-ark-container="graph"]');
  const graphBox = await requiredBoundingBox(graph);
  const boxes = await graphNodeBoxes(page);
  expect(boxes).toHaveLength(5);
  const byId = Object.fromEntries(boxes.map(box => [box.id, box]));
  for (const id of ["manual_a", "manual_b"]) {
    expect(byId[id].x - graphBox.x).toBeCloseTo(30, 0);
    expect(byId[id].y - graphBox.y).toBeCloseTo(40, 0);
  }
  expect(boxesOverlap(byId.manual_a, byId.manual_b)).toBe(true);
  for (const autoId of ["auto_missing", "auto_partial", "auto_invalid"]) {
    await expect(
      graph.locator(`[data-model-id="${autoId}"] .ark-harness-graph-handle`)
    ).toHaveCount(1);
    expect(boxesOverlap(byId[autoId], byId.manual_a)).toBe(false);
    expect(boxesOverlap(byId[autoId], byId.manual_b)).toBe(false);
  }
  expectNoOverlaps(boxes.filter(box => box.id.startsWith("auto_")));
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(3);
});

test("表示時は座標を非永続化し、ドラッグした node だけ手動座標へ昇格する", async ({
  page,
}) => {
  await page.setContent(mixedLayoutHtml());
  await connectSubmissionPort(page);
  const submit = page.getByRole("button", {
    name: "変更を親フレームへ送信する",
  });
  await submit.click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const initialNodes = await page.evaluate(
    () =>
      (
        window as typeof window & {
          arkHarnessSubmission?: {
            model: { nodes: Array<{ id: string; ext?: unknown }> };
          };
        }
      ).arkHarnessSubmission?.model.nodes
  );
  expect(
    initialNodes?.find(node => node.id === "auto_missing")?.ext
  ).toBeUndefined();
  expect(initialNodes?.find(node => node.id === "auto_partial")?.ext).toEqual({
    x: 90,
  });

  const autoNode = page.locator('[data-model-id="auto_missing"]').first();
  const before = await requiredBoundingBox(autoNode);
  const handle = await requiredBoundingBox(
    autoNode.locator(".ark-harness-graph-handle")
  );
  await page.evaluate(() => {
    delete (window as typeof window & { arkHarnessSubmission?: unknown })
      .arkHarnessSubmission;
  });
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 60,
    handle.y + handle.height / 2 + 40
  );
  await page.mouse.up();
  await submit.click();
  await page.waitForFunction(() =>
    Boolean(
      (window as typeof window & { arkHarnessSubmission?: unknown })
        .arkHarnessSubmission
    )
  );
  const submittedNodes = await page.evaluate(
    () =>
      (
        window as typeof window & {
          arkHarnessSubmission?: {
            model: {
              nodes: Array<{
                id: string;
                ext?: Record<string, unknown>;
              }>;
            };
          };
        }
      ).arkHarnessSubmission?.model.nodes
  );
  const dragged = submittedNodes?.find(node => node.id === "auto_missing");
  const graphBox = await requiredBoundingBox(
    page.locator('[data-ark-container="graph"]')
  );
  expect(dragged?.ext?.x).toBeCloseTo(before.x - graphBox.x + 60, 0);
  expect(dragged?.ext?.y).toBeCloseTo(before.y - graphBox.y + 40, 0);
  expect(submittedNodes?.find(node => node.id === "auto_invalid")?.ext).toEqual(
    {
      x: "120",
      y: 80,
    }
  );
  expect(submittedNodes?.find(node => node.id === "manual_a")?.ext).toEqual({
    x: 30,
    y: 40,
  });
  const cleanHtml = await page.evaluate(
    () =>
      (
        window as typeof window & {
          arkHarnessSubmission?: { html: string };
        }
      ).arkHarnessSubmission?.html
  );
  expect(cleanHtml).not.toContain("--ark-harness-graph-min-width");
  expect(cleanHtml).not.toContain("--ark-harness-graph-min-height");
  expect(cleanHtml).not.toContain("ark-harness-graph-layout");
});

test("自動配置は text resize とモデル JSON 再適用で再計算する", async ({
  page,
}) => {
  await page.setContent(autoLayoutHtml());
  let boxes = await graphNodeBoxes(page);
  let byId = Object.fromEntries(boxes.map(box => [box.id, box]));
  const branchBBefore = byId.branch_b.y;
  await page
    .locator('[data-model-id="branch_a"] h2[data-model-id="branch_a"]')
    .fill("Branch A with enough text to wrap ".repeat(10));
  await expect
    .poll(async () => {
      boxes = await graphNodeBoxes(page);
      byId = Object.fromEntries(boxes.map(box => [box.id, box]));
      return byId.branch_b.y;
    })
    .toBeGreaterThan(branchBBefore + 20);

  const editedModel = await page
    .locator("#ark-diagram-model")
    .evaluate(element => {
      const parsed = JSON.parse(element.textContent || "") as {
        ext: { layout: { direction: string } };
      };
      parsed.ext.layout.direction = "TB";
      return parsed;
    });
  await page
    .getByRole("button", { name: "モデル JSON を直接編集する" })
    .click();
  await page.locator(".ark-harness-textarea").fill(JSON.stringify(editedModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();
  await expect
    .poll(async () => {
      boxes = await graphNodeBoxes(page);
      byId = Object.fromEntries(boxes.map(box => [box.id, box]));
      return byId.branch_a.y > byId.source.y + byId.source.height;
    })
    .toBe(true);
});

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
    '.ark-harness-edge-main[data-ark-edge-id="e_order_owner"]'
  );
  const fromCardinality = graph.locator(
    '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="from"][data-ark-edge-cardinality="one"]'
  );
  const toCardinality = graph.locator(
    '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"][data-ark-edge-cardinality="zero-or-many"]'
  );

  await expect(fromCardinality.locator("line")).toHaveCount(1);
  expect(
    await graph.evaluate(container => {
      const element = container.querySelector(
        '.ark-harness-edge-cardinality[data-ark-edge-id="e_order_owner"][data-ark-edge-end="from"] line'
      ) as SVGLineElement | null;
      if (!element) throw new Error("from cardinality がありません");
      return {
        length: element.getTotalLength(),
        stroke: getComputedStyle(element).stroke,
      };
    })
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
    '.ark-harness-edge-main[data-ark-edge-id="e_account_user"]'
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

test("edge 端点 drag の Escape と pointercancel は model を変更しない", async ({
  page,
}) => {
  await openEdgeSemanticsDiagram(page);
  await connectSubmissionPort(page);
  const graph = page.locator('[data-ark-container="graph"]');
  const graphBox = await requiredBoundingBox(graph);
  const handleSelector =
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_owner"][data-ark-edge-end="to"]';

  let handle = graph.locator(handleSelector);
  let handleBox = await requiredBoundingBox(handle);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    graphBox.x + graphBox.width - 20,
    graphBox.y + graphBox.height - 20,
    { steps: 3 }
  );
  await expect(handle).toHaveClass(/ark-harness-edge-delete-pending/);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(graph.locator(".ark-harness-edge-preview")).toHaveCount(0);
  expect(
    (await readCurrentModel(page)).edges.find(
      edge => edge.id === "e_order_owner"
    )
  ).toMatchObject({ from: "order", to: "user" });

  handle = graph.locator(handleSelector);
  handleBox = await requiredBoundingBox(handle);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    graphBox.x + graphBox.width - 20,
    graphBox.y + graphBox.height - 20
  );
  await expect(handle).toHaveClass(/ark-harness-edge-delete-pending/);
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

test("kind 候補は authored CSS rule を宣言順かつ重複なしで収集する", async ({
  page,
}) => {
  await page.setContent(kindCandidateHtml());

  const picker = page.getByRole("combobox", {
    name: /Candidate.*quoted/,
  });
  await expect(picker).toHaveCount(1);
  expect(await picker.locator("option").allTextContents()).toEqual([
    "quoted",
    "single",
    "unquoted",
    "nested",
    "escaped&kind",
  ]);
  await expect(picker.locator("option")).toHaveCount(5);
  await expect(
    picker.locator("option", { hasText: "declaration" })
  ).toHaveCount(0);
  await expect(picker.locator("option", { hasText: "comment" })).toHaveCount(0);
});

test("kind 候補が無い図ではピッカーを付けず既存編集 UI を維持する", async ({
  page,
}) => {
  await page.setContent(invalidCoordinateHtml());

  const graph = page.locator('[data-ark-container="graph"]');
  await expect(graph.locator(".ark-harness-kind-picker")).toHaveCount(0);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(4);
  await expect(
    graph.locator('[data-model-id="valid_a"].ark-harness-editable')
  ).toHaveAttribute("contenteditable", "true");
});

test("kind ピッカーは候補外の現在値を保持し候補選択時だけ更新する", async ({
  page,
}) => {
  const boundaryModel = structuredClone(model);
  boundaryModel.nodes[0].kind = "legacy-kind";
  await openDiagram(page, boundaryModel);

  const order = page.locator(
    '[data-ark-container="graph"] > section[data-model-id="order"]'
  );
  const picker = order.locator("select.ark-harness-kind-select");
  const current = picker.locator("option").first();
  await expect(order).toHaveAttribute("data-kind", "legacy-kind");
  await expect(picker).toHaveValue("legacy-kind");
  await expect(current).toBeDisabled();
  await expect(current).toHaveText("legacy-kind");
  await expect(current).toHaveAttribute("value", "legacy-kind");
  expect(await picker.locator("option").allTextContents()).toEqual([
    "legacy-kind",
    "aggregate",
    "entity",
    "event",
  ]);

  await picker.selectOption("entity");
  await expect(order).toHaveAttribute("data-kind", "entity");
  await expect(picker).toHaveValue("entity");
  await expect(picker.locator("option")).toHaveCount(3);
});

test("kind ピッカーは untrusted 値を text と value だけで扱う", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  await page.setContent(untrustedKindHtml());

  const currentKind = 'current"><img src=x onerror=alert(1)>';
  const candidateKind = 'candidate"><script src=x>';
  const root = page.locator(
    '[data-ark-container="graph"] > [data-model-id="unsafe"]'
  );
  const picker = root.locator("select.ark-harness-kind-select");
  const options = picker.locator("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toBeDisabled();
  await expect(options.nth(0)).toHaveText(currentKind);
  await expect(options.nth(0)).toHaveAttribute("value", currentKind);
  await expect(options.nth(1)).toHaveText(candidateKind);
  await expect(options.nth(1)).toHaveAttribute("value", candidateKind);
  await expect(
    page.locator(
      "img, script:not(#ark-diagram-model):not(#ark-diagram-harness), [onerror], [onload]"
    )
  ).toHaveCount(0);

  await picker.selectOption(candidateKind);
  await expect(root).toHaveAttribute("data-kind", candidateKind);
  await expect(
    page.locator(
      "img, script:not(#ark-diagram-model):not(#ark-diagram-harness), [onerror], [onload]"
    )
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("モデル直接編集後に kind ピッカーと方向表示を再同期する", async ({
  page,
}) => {
  await openDiagram(page);
  const order = page.locator(
    '[data-ark-container="graph"] > section[data-model-id="order"]'
  );
  const picker = order.locator("select.ark-harness-kind-select");
  const editButton = page.getByRole("button", {
    name: "モデル JSON を直接編集する",
  });

  await picker.selectOption("event");
  await expect(order).toHaveAttribute("data-kind", "event");

  const candidateModel = structuredClone(model);
  candidateModel.nodes[0].kind = "entity";
  await editButton.click();
  await page
    .locator(".ark-harness-textarea")
    .fill(JSON.stringify(candidateModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();
  await expect(order).toHaveAttribute("data-kind", "entity");
  await expect(picker).toHaveValue("entity");
  await expect(picker).toHaveAccessibleName(/Order.*entity/);

  const unknownModel = structuredClone(
    candidateModel
  ) as typeof candidateModel & {
    ext?: { layout: { direction: string } };
  };
  unknownModel.nodes[0].kind = "custom-kind";
  unknownModel.ext = { layout: { direction: "TB" } };
  await editButton.click();
  await page
    .locator(".ark-harness-textarea")
    .fill(JSON.stringify(unknownModel));
  await page.getByRole("button", { name: "反映", exact: true }).click();
  await expect(order).toHaveAttribute("data-kind", "custom-kind");
  await expect(picker).toHaveValue("custom-kind");
  await expect(picker).toHaveAccessibleName(/Order.*custom-kind/);
  const current = picker.locator("option").first();
  await expect(current).toBeDisabled();
  await expect(current).toHaveText("custom-kind");
  await expect(
    page.getByRole("button", {
      name: "方向: TB（現在 TB。LR に切り替える）",
    })
  ).toBeVisible();
});

test("kind ピッカーで CSS 候補を選び投影・geometry・保存へ同期する", async ({
  page,
}) => {
  await openDiagram(page);
  await connectSubmissionPort(page);

  const graph = page.locator('[data-ark-container="graph"]');
  const order = graph.locator(':scope > section[data-model-id="order"]');
  const user = graph.locator(':scope > section[data-model-id="user"]');
  const orderPickerWrapper = order.locator(".ark-harness-kind-picker");
  const orderPicker = order.locator("select.ark-harness-kind-select");
  const userPicker = user.locator("select.ark-harness-kind-select");

  await expect(orderPicker).toHaveCount(1);
  await expect(userPicker).toHaveCount(1);
  await expect(orderPicker).toHaveAccessibleName(/Order.*aggregate/);
  await expect(userPicker).toHaveAccessibleName(/User.*entity/);
  expect(await orderPicker.locator("option").allTextContents()).toEqual([
    "aggregate",
    "entity",
    "event",
  ]);
  expect(await userPicker.locator("option").allTextContents()).toEqual([
    "aggregate",
    "entity",
    "event",
  ]);
  await expect(
    graph.locator(
      '[data-ark-group] select, h2[data-model-id="order"] select, li select, .ark-harness-edge-layer select'
    )
  ).toHaveCount(0);
  await expect(
    page.locator('body > section[data-model-id="external"] select')
  ).toHaveCount(0);

  await expect(orderPickerWrapper).toHaveCSS("opacity", "0");
  const beforeHoverBox = await requiredBoundingBox(order);
  await order.hover();
  await expect(orderPickerWrapper).toHaveCSS("opacity", "1");
  const [hoverBox, pickerBox, titleBox, dragHandleBox] = await Promise.all([
    requiredBoundingBox(order),
    requiredBoundingBox(orderPicker),
    requiredBoundingBox(order.locator('h2[data-model-id="order"]')),
    requiredBoundingBox(order.locator(".ark-harness-graph-handle")),
  ]);
  expect(hoverBox).toEqual(beforeHoverBox);
  expect(boxesOverlap(pickerBox, titleBox)).toBe(false);
  expect(boxesOverlap(pickerBox, dragHandleBox)).toBe(false);

  const beforeModel = structuredClone(model);
  const beforeBox = await requiredBoundingBox(order);
  const beforeStyle = await order.evaluate(element => {
    const icon = element.querySelector(".kind-icon");
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderLeftColor: style.borderLeftColor,
      icon: icon ? getComputedStyle(icon, "::before").content : "none",
    };
  });

  await orderPicker.selectOption("event");

  await expect(order).toHaveAttribute("data-kind", "event");
  await expect(order.locator('h2[data-model-id="order"]')).toHaveAttribute(
    "data-kind",
    "event"
  );
  await expect(orderPicker).toHaveValue("event");
  await expect(orderPicker).toHaveAccessibleName(/Order.*event/);
  const afterStyle = await order.evaluate(element => {
    const icon = element.querySelector(".kind-icon");
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderLeftColor: style.borderLeftColor,
      icon: icon ? getComputedStyle(icon, "::before").content : "none",
    };
  });
  expect(afterStyle.backgroundColor).not.toBe(beforeStyle.backgroundColor);
  expect(afterStyle.borderLeftColor).not.toBe(beforeStyle.borderLeftColor);
  expect(afterStyle.icon).not.toBe(beforeStyle.icon);

  await expect
    .poll(async () => {
      const box = await order.boundingBox();
      return box ? { width: box.width, height: box.height } : null;
    })
    .toEqual({ width: 280, height: 260 });
  const afterBox = await requiredBoundingBox(order);
  expect(afterBox.width).toBeGreaterThan(beforeBox.width);
  expect(afterBox.height).toBeGreaterThan(beforeBox.height);

  await expect
    .poll(async () => {
      const [groupBox, orderBox, userBox] = await Promise.all([
        requiredBoundingBox(
          graph.locator(
            ':scope > [data-ark-group][data-model-id="ordering-context"]'
          )
        ),
        requiredBoundingBox(order),
        requiredBoundingBox(user),
      ]);
      return (
        groupBox.x <= orderBox.x &&
        groupBox.y <= orderBox.y &&
        groupBox.x + groupBox.width >= orderBox.x + orderBox.width &&
        groupBox.y + groupBox.height >= orderBox.y + orderBox.height &&
        groupBox.x <= userBox.x &&
        groupBox.y <= userBox.y &&
        groupBox.x + groupBox.width >= userBox.x + userBox.width &&
        groupBox.y + groupBox.height >= userBox.y + userBox.height
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const edge = await readEdge(page);
      const handles = await graph
        .locator('.ark-harness-edge-handle[data-ark-edge-id="e_order_user"]')
        .evaluateAll(elements =>
          elements.map(element => {
            const rect = element.getBoundingClientRect();
            return {
              end: element.getAttribute("data-ark-edge-end"),
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
            };
          })
        );
      const from = handles.find(handle => handle.end === "from");
      const to = handles.find(handle => handle.end === "to");
      return Boolean(
        from &&
          to &&
          Math.abs(from.x - edge.x1) < 1 &&
          Math.abs(from.y - edge.y1) < 1 &&
          Math.abs(to.x - edge.x2) < 1 &&
          Math.abs(to.y - edge.y2) < 1 &&
          edge.x1 >= afterBox.x &&
          edge.x1 <= afterBox.x + afterBox.width &&
          edge.y1 >= afterBox.y &&
          edge.y1 <= afterBox.y + afterBox.height
      );
    })
    .toBe(true);

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
      (
        window as typeof window & {
          arkHarnessSubmission?: { model: DiagramModel; html: string };
        }
      ).arkHarnessSubmission
  );
  if (!submission) throw new Error("submission がありません");
  expect(submission.model).toEqual({
    ...beforeModel,
    nodes: beforeModel.nodes.map(node =>
      node.id === "order" ? { ...node, kind: "event" } : node
    ),
  });
  expect(describeModelDiff(beforeModel, submission.model)).toEqual([]);
  expect(submission.html).toContain('data-kind="event"');
  expect(submission.html).toContain('id="ark-diagram-model"');
  expect(submission.html).toContain('data-ark-container="graph"');
  expect(submission.html).toContain('[data-kind="event"]');
  expect(submission.html).not.toContain("ark-harness-kind-picker");
  expect(submission.html).not.toContain("ark-harness-layout-direction");
  expect(submission.html).not.toContain("ark-harness-graph-handle");
  expect(submission.html).not.toContain("ark-harness-edge-handle");
  expect(submission.html).not.toContain("Content-Security-Policy");
  expect(submission.html).not.toContain("contenteditable");
  expect(submission.html).not.toContain("<option");
  expect(submission.html).not.toContain("data-ark-harness-ui");
  expect(
    await page.evaluate(cleanHtml => {
      const parsed = new DOMParser().parseFromString(cleanHtml, "text/html");
      return Array.from(parsed.querySelectorAll("[class]")).some(element =>
        Array.from(element.classList).some(className =>
          className.startsWith("ark-harness-")
        )
      );
    }, submission.html)
  ).toBe(false);
});

test("sample は複数 kind を色とアイコンで区別する", async ({ page }) => {
  await openSampleDiagram(page);

  const modelScript = page.locator("#ark-diagram-model");
  const initialModelText = await modelScript.textContent();
  const sampleModel = await modelScript.evaluate(
    element =>
      JSON.parse(element.textContent || "") as {
        ext: {
          layout: {
            direction: string;
            rankSpacing: number;
            nodeSpacing: number;
            padding: number;
          };
        };
        nodes: Array<{
          id: string;
          kind?: string;
          ext?: Record<string, unknown>;
        }>;
      }
  );
  expect(sampleModel.ext.layout).toEqual({
    direction: "LR",
    rankSpacing: 72,
    nodeSpacing: 40,
    padding: 40,
  });
  expect(
    sampleModel.nodes.every(
      node => node.ext?.x === undefined && node.ext?.y === undefined
    )
  ).toBe(true);
  const modelKinds = Object.fromEntries(
    sampleModel.nodes.map(node => [node.id, node.kind])
  );
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
  const [orderBox, userBox] = await Promise.all([
    requiredBoundingBox(graph.locator('[data-model-id="order"]').first()),
    requiredBoundingBox(graph.locator('[data-model-id="user"]').first()),
  ]);
  expect(boxesOverlap(orderBox, userBox)).toBe(false);
  expect(userBox.x - (orderBox.x + orderBox.width)).toBeGreaterThanOrEqual(71);
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
  ).toHaveCount(1);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(2);
  await expect(
    graph.locator('li[data-model-id="order_id"] .ark-harness-text')
  ).toHaveAttribute("contenteditable", "true");
  expect(await modelScript.textContent()).toBe(initialModelText);
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

test("kind 変更と node・edge・field・list 編集を同じ送信 model に反映する", async ({
  page,
}) => {
  await openDiagram(page);
  await connectSubmissionPort(page);

  const order = page.locator('section[data-model-id="order"]');
  await order.locator("select.ark-harness-kind-select").selectOption("event");
  await expect(order).toHaveAttribute("data-kind", "event");
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
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

  const toHandle = page.locator(
    '.ark-harness-edge-handle[data-ark-edge-id="e_order_user"][data-ark-edge-end="to"]'
  );
  const [toHandleBox, movedOrderBox] = await Promise.all([
    requiredBoundingBox(toHandle),
    requiredBoundingBox(order),
  ]);
  await page.mouse.move(
    toHandleBox.x + toHandleBox.width / 2,
    toHandleBox.y + toHandleBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    movedOrderBox.x + movedOrderBox.width / 2,
    movedOrderBox.y + movedOrderBox.height / 2,
    { steps: 5 }
  );
  await expect(page.locator(".ark-harness-edge-drop-indicator")).toBeVisible();
  await page.mouse.up();
  await expect(
    page.locator('path.ark-harness-edge-main[data-ark-edge-id="e_order_user"]')
  ).toHaveCount(1);

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
          kind: "event",
          ext: { x: 120, y: 110 },
          fields: [
            { id: "order_status", label: "state" },
            { id: "order_id", label: "id" },
          ],
        },
        { id: "user" },
        { id: "external" },
      ],
      edges: [{ id: "e_order_user", from: "order", to: "order" }],
    },
  });
  const submittedModel = (submission as { model: DiagramModel }).model;
  expect(describeModelDiff(model, submittedModel)).toEqual([
    "Order の status を state に変更",
    "Order のフィールド順を state, id に変更",
    "Order から User への関連「belongs to」を Order から Order への関連「belongs to」 に変更",
  ]);
  const html = (submission as { html: string }).html;
  expect(html).toContain('data-kind="event"');
  expect(html).not.toContain("ark-harness-kind-picker");
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

test("不正座標は座標未指定として自動配置し graph 外参照だけを除外する", async ({
  page,
}) => {
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
  ).toHaveCount(1);
  await expect(
    graph.locator('.ark-harness-edge-main[data-ark-edge-id="outside_edge"]')
  ).toHaveCount(0);
  await expect(
    graph.locator(".ark-harness-edge-main[data-ark-edge-id]")
  ).toHaveCount(2);
  await expect(graph.locator(".ark-harness-graph-handle")).toHaveCount(4);
  await expect(
    graph.locator('[data-model-id="string_x"] .ark-harness-graph-handle')
  ).toHaveCount(1);
  await expect(
    graph.locator('[data-model-id="null_y"] .ark-harness-graph-handle')
  ).toHaveCount(1);
  expectNoOverlaps(await graphNodeBoxes(page));
  expect(errors).toEqual([]);
});
