export interface DiagramLayoutNode {
  id: string;
  index: number;
  width: number;
  height: number;
  manual?: { x: number; y: number };
}

export interface DiagramLayoutEdge {
  from: string;
  to: string;
}

export interface DiagramLayoutGroup {
  id: string;
  index: number;
  nodes: string[];
  outsets: { left: number; top: number; right: number; bottom: number };
}

export interface DiagramLayoutInput {
  nodes: DiagramLayoutNode[];
  edges: DiagramLayoutEdge[];
  groups: DiagramLayoutGroup[];
  direction: "LR" | "TB";
  rankSpacing: number;
  nodeSpacing: number;
  padding: number;
}

export interface DiagramLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramLayoutResult {
  fallback: null | "empty-group" | "missing-member" | "duplicate-membership";
  positions: Record<string, { x: number; y: number }>;
  groups: Record<
    string,
    { member: DiagramLayoutRect; outer: DiagramLayoutRect }
  >;
  units: Array<{ id: string; rect: DiagramLayoutRect; group: boolean }>;
}

/**
 * DOM に依存しない group-aware layout kernel。
 *
 * browser harness へ function literal として埋め込めるよう、実装はこの関数の
 * closure 内だけで完結させる。
 */
export function layoutDiagram(_input: DiagramLayoutInput): DiagramLayoutResult {
  type Item = {
    id: string;
    order: number;
    width: number;
    height: number;
    rank: number;
    manual?: { x: number; y: number };
  };
  type Unit = {
    id: string;
    order: number;
    group: boolean;
    groupId?: string;
    nodeIds: string[];
    rect: DiagramLayoutRect;
    fixed: boolean;
  };

  const input = _input;
  const positions: Record<string, { x: number; y: number }> = {};
  const groupGeometry: DiagramLayoutResult["groups"] = {};
  const nodeById = new Map(input.nodes.map(node => [node.id, node]));
  const membership = new Map<string, string>();
  let fallback: DiagramLayoutResult["fallback"] = null;

  for (const group of input.groups) {
    if (group.nodes.length === 0) {
      fallback = "empty-group";
      break;
    }
    for (const id of group.nodes) {
      if (!nodeById.has(id)) {
        fallback = "missing-member";
        break;
      }
      if (membership.has(id)) {
        fallback = "duplicate-membership";
        break;
      }
      membership.set(id, group.id);
    }
    if (fallback) break;
  }
  if (fallback) {
    for (const node of input.nodes) {
      if (node.manual) positions[node.id] = { ...node.manual };
    }
    return { fallback, positions, groups: {}, units: [] };
  }

  const collide = (
    left: DiagramLayoutRect,
    right: DiagramLayoutRect,
    gap: number
  ) =>
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y;

  const ranksFor = (
    ids: string[],
    edges: DiagramLayoutEdge[],
    orderById: Map<string, number>
  ) => {
    const idSet = new Set(ids);
    const adjacency = new Map(ids.map(id => [id, [] as string[]]));
    const seen = new Set<string>();
    for (const edge of edges) {
      if (edge.from === edge.to || !idSet.has(edge.from) || !idSet.has(edge.to))
        continue;
      const key = `${edge.from}\0${edge.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      adjacency.get(edge.from)?.push(edge.to);
    }
    for (const targets of adjacency.values()) {
      targets.sort(
        (left, right) =>
          (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0)
      );
    }

    let nextIndex = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indexes = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const components: string[][] = [];
    const visit = (id: string) => {
      indexes.set(id, nextIndex);
      lowLinks.set(id, nextIndex);
      nextIndex += 1;
      stack.push(id);
      onStack.add(id);
      for (const target of adjacency.get(id) ?? []) {
        if (!indexes.has(target)) {
          visit(target);
          lowLinks.set(
            id,
            Math.min(lowLinks.get(id) ?? 0, lowLinks.get(target) ?? 0)
          );
        } else if (onStack.has(target)) {
          lowLinks.set(
            id,
            Math.min(lowLinks.get(id) ?? 0, indexes.get(target) ?? 0)
          );
        }
      }
      if (lowLinks.get(id) !== indexes.get(id)) return;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      component.sort(
        (left, right) =>
          (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0)
      );
      components.push(component);
    };
    for (const id of ids) {
      if (!indexes.has(id)) visit(id);
    }
    components.sort(
      (left, right) =>
        (orderById.get(left[0]) ?? 0) - (orderById.get(right[0]) ?? 0)
    );

    const componentById = new Map<string, number>();
    const componentOrder: number[] = [];
    components.forEach((component, componentIndex) => {
      componentOrder[componentIndex] = orderById.get(component[0]) ?? 0;
      for (const id of component) componentById.set(id, componentIndex);
    });
    const outgoing = components.map(() => new Set<number>());
    const indegrees = components.map(() => 0);
    for (const [from, targets] of adjacency) {
      const fromComponent = componentById.get(from) as number;
      for (const to of targets) {
        const toComponent = componentById.get(to) as number;
        if (
          fromComponent === toComponent ||
          outgoing[fromComponent].has(toComponent)
        )
          continue;
        outgoing[fromComponent].add(toComponent);
        indegrees[toComponent] += 1;
      }
    }
    const byOrder = (left: number, right: number) =>
      componentOrder[left] - componentOrder[right];
    const queue = indegrees
      .map((degree, index) => ({ degree, index }))
      .filter(entry => entry.degree === 0)
      .map(entry => entry.index)
      .sort(byOrder);
    const componentRanks = components.map(() => 0);
    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const target of [...outgoing[current]].sort(byOrder)) {
        componentRanks[target] = Math.max(
          componentRanks[target],
          componentRanks[current] + 1
        );
        indegrees[target] -= 1;
        if (indegrees[target] === 0) {
          queue.push(target);
          queue.sort(byOrder);
        }
      }
    }
    return Object.fromEntries(
      ids.map(id => [id, componentRanks[componentById.get(id) as number] ?? 0])
    ) as Record<string, number>;
  };

  const pack = (items: Item[], gap: number, padding: number) => {
    const direction = input.direction;
    const result: Record<string, { x: number; y: number }> = {};
    const occupied: Array<DiagramLayoutRect & { id: string }> = [];
    const manualItems = items.filter(item => item.manual);
    const primaryOrigin =
      manualItems.length === 0
        ? padding
        : Math.min(
            ...manualItems.map(item =>
              direction === "TB"
                ? (item.manual as { y: number }).y
                : (item.manual as { x: number }).x
            )
          );
    const secondaryOrigin =
      manualItems.length === 0
        ? padding
        : Math.min(
            ...manualItems.map(item =>
              direction === "TB"
                ? (item.manual as { x: number }).x
                : (item.manual as { y: number }).y
            )
          );
    for (const item of manualItems) {
      const manual = item.manual as { x: number; y: number };
      result[item.id] = { ...manual };
      occupied.push({
        id: item.id,
        ...manual,
        width: item.width,
        height: item.height,
      });
    }

    const maxRank = Math.max(0, ...items.map(item => item.rank));
    const primaryStarts: number[] = [];
    let primary = primaryOrigin;
    for (let rank = 0; rank <= maxRank; rank += 1) {
      primaryStarts[rank] = primary;
      const rankItems = items.filter(item => item.rank === rank);
      const largest = Math.max(
        0,
        ...rankItems.map(item =>
          direction === "TB" ? item.height : item.width
        )
      );
      primary += largest + input.rankSpacing;
    }

    for (let rank = 0; rank <= maxRank; rank += 1) {
      let secondary = secondaryOrigin;
      for (const item of items
        .filter(entry => entry.rank === rank && !entry.manual)
        .sort(
          (left, right) =>
            left.order - right.order || left.id.localeCompare(right.id)
        )) {
        const rect: DiagramLayoutRect & { id: string } = {
          id: item.id,
          x: direction === "TB" ? secondary : primaryStarts[rank],
          y: direction === "TB" ? primaryStarts[rank] : secondary,
          width: item.width,
          height: item.height,
        };
        const maximumAttempts = items.length * 4 + 8;
        let attempts = 0;
        while (attempts < maximumAttempts) {
          const collision = occupied.find(other => collide(rect, other, gap));
          if (!collision) break;
          secondary =
            (direction === "TB"
              ? collision.x + collision.width
              : collision.y + collision.height) + gap;
          if (direction === "TB") rect.x = secondary;
          else rect.y = secondary;
          attempts += 1;
        }
        if (attempts === maximumAttempts) {
          secondary = Math.max(
            secondaryOrigin,
            ...occupied.map(other =>
              direction === "TB"
                ? other.x + other.width + gap
                : other.y + other.height + gap
            )
          );
          if (direction === "TB") rect.x = secondary;
          else rect.y = secondary;
        }
        result[item.id] = { x: rect.x, y: rect.y };
        occupied.push(rect);
        secondary =
          (direction === "TB" ? rect.x + rect.width : rect.y + rect.height) +
          gap;
      }
    }
    return result;
  };

  const hullFor = (ids: string[]): DiagramLayoutRect => {
    const firstNode = nodeById.get(ids[0]) as DiagramLayoutNode;
    const firstPosition = positions[ids[0]];
    let left = firstPosition.x;
    let top = firstPosition.y;
    let right = left + firstNode.width;
    let bottom = top + firstNode.height;
    for (const id of ids.slice(1)) {
      const node = nodeById.get(id) as DiagramLayoutNode;
      const position = positions[id];
      left = Math.min(left, position.x);
      top = Math.min(top, position.y);
      right = Math.max(right, position.x + node.width);
      bottom = Math.max(bottom, position.y + node.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const units: Unit[] = [];
  for (const group of input.groups) {
    const members = group.nodes
      .map(id => nodeById.get(id) as DiagramLayoutNode)
      .sort(
        (left, right) =>
          left.index - right.index || left.id.localeCompare(right.id)
      );
    const memberIds = members.map(member => member.id);
    const orderById = new Map(members.map(member => [member.id, member.index]));
    const ranks = ranksFor(memberIds, input.edges, orderById);
    const internal = pack(
      members.map(member => ({
        id: member.id,
        order: member.index,
        width: member.width,
        height: member.height,
        rank: ranks[member.id],
        manual: member.manual && { ...member.manual },
      })),
      input.nodeSpacing,
      0
    );
    Object.assign(positions, internal);
    const member = hullFor(memberIds);
    const outer = {
      x: member.x - group.outsets.left,
      y: member.y - group.outsets.top,
      width: member.width + group.outsets.left + group.outsets.right,
      height: member.height + group.outsets.top + group.outsets.bottom,
    };
    groupGeometry[group.id] = { member, outer };
    units.push({
      id: `group:${group.id}`,
      order: Math.min(...members.map(member => member.index)),
      group: true,
      groupId: group.id,
      nodeIds: memberIds,
      rect: outer,
      fixed: members.some(member => Boolean(member.manual)),
    });
  }
  for (const node of input.nodes) {
    if (membership.has(node.id)) continue;
    if (node.manual) positions[node.id] = { ...node.manual };
    units.push({
      id: `node:${node.id}`,
      order: node.index,
      group: false,
      nodeIds: [node.id],
      rect: {
        x: node.manual?.x ?? 0,
        y: node.manual?.y ?? 0,
        width: node.width,
        height: node.height,
      },
      fixed: Boolean(node.manual),
    });
  }
  units.sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id)
  );

  const unitByNode = new Map<string, string>();
  for (const unit of units) {
    for (const id of unit.nodeIds) unitByNode.set(id, unit.id);
  }
  const unitEdges: DiagramLayoutEdge[] = [];
  const seenUnitEdges = new Set<string>();
  for (const edge of input.edges) {
    const from = unitByNode.get(edge.from);
    const to = unitByNode.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    if (seenUnitEdges.has(key)) continue;
    seenUnitEdges.add(key);
    unitEdges.push({ from, to });
  }
  const unitIds = units.map(unit => unit.id);
  const unitOrder = new Map(units.map((unit, index) => [unit.id, index]));
  const unitRanks = ranksFor(unitIds, unitEdges, unitOrder);
  const topPositions = pack(
    units.map((unit, index) => ({
      id: unit.id,
      order: index,
      width: unit.rect.width,
      height: unit.rect.height,
      rank: unitRanks[unit.id],
      manual: unit.fixed ? { x: unit.rect.x, y: unit.rect.y } : undefined,
    })),
    input.nodeSpacing,
    input.padding
  );

  for (const unit of units) {
    const target = topPositions[unit.id];
    const delta = {
      x: target.x - unit.rect.x,
      y: target.y - unit.rect.y,
    };
    if (!unit.fixed) {
      for (const id of unit.nodeIds) {
        const current = positions[id] ?? { x: 0, y: 0 };
        positions[id] = { x: current.x + delta.x, y: current.y + delta.y };
      }
      unit.rect = { ...unit.rect, x: target.x, y: target.y };
    }
    if (unit.group && unit.groupId) {
      const member = hullFor(unit.nodeIds);
      const old = groupGeometry[unit.groupId];
      groupGeometry[unit.groupId] = {
        member,
        outer: {
          ...old.outer,
          x: unit.rect.x,
          y: unit.rect.y,
        },
      };
    }
  }

  return {
    fallback: null,
    positions,
    groups: groupGeometry,
    units: units.map(unit => ({
      id: unit.id,
      rect: { ...unit.rect },
      group: unit.group,
    })),
  };
}
