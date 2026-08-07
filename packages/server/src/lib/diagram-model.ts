/**
 * 図の意味モデル（コア語彙）。
 *
 * 標準化するのは node / edge / field / group と label だけで、図種固有の意味は
 * `ext` に逃がす（判断4.3）。サーバーが意味差分の文を組み立てられる最小限に絞り、
 * 図種を増やしても実装を足さずに済むようにする。
 */

export interface DiagramField {
  id: string;
  label: string;
  ext?: Record<string, unknown>;
}

export interface DiagramNode {
  id: string;
  label: string;
  /** entity / step / state など。サーバーは解釈せず、投影側と skill の取り決め */
  kind?: string;
  /** kind=note の自由記述本文。label / fields とは独立して保持する */
  noteText?: string;
  fields?: DiagramField[];
  ext?: Record<string, unknown>;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  ext?: Record<string, unknown>;
}

export interface DiagramGroup {
  id: string;
  label: string;
  nodes: string[];
  ext?: Record<string, unknown>;
}

export interface DiagramModel {
  version: 1;
  /**
   * 図種（er / event-storming など）。サーバーは値を解釈せず保持するだけで、
   * 既知の図種なら配信時に投影 DOM と CSS を生成する（diagram-builtin.ts）。
   * 未知の値・未指定なら従来どおり生成物が書いた投影をそのまま使う。
   */
  type?: string;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  ext?: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; model: DiagramModel }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asExt(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

/** モデル JSON を検証して正規化する。id の重複と edge の参照切れを弾く。 */
export function parseDiagramModel(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: `モデル JSON を解析できません: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!isRecord(raw))
    return { ok: false, error: "モデルはオブジェクトである必要があります" };
  if (raw.version !== 1)
    return { ok: false, error: "version は 1 である必要があります" };

  const seen = new Set<string>();
  const dup = (id: string): string | null => {
    if (seen.has(id)) return id;
    seen.add(id);
    return null;
  };

  const nodes: DiagramNode[] = [];
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (
      !isRecord(n) ||
      typeof n.id !== "string" ||
      typeof n.label !== "string"
    ) {
      return { ok: false, error: "node には文字列の id と label が必要です" };
    }
    const d = dup(n.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };

    const fields: DiagramField[] = [];
    for (const f of Array.isArray(n.fields) ? n.fields : []) {
      if (
        !isRecord(f) ||
        typeof f.id !== "string" ||
        typeof f.label !== "string"
      ) {
        return {
          ok: false,
          error: `node ${n.id} の field には文字列の id と label が必要です`,
        };
      }
      const fd = dup(f.id);
      if (fd) return { ok: false, error: `id が重複しています: ${fd}` };
      fields.push({ id: f.id, label: f.label, ext: asExt(f.ext) });
    }

    nodes.push({
      id: n.id,
      label: n.label,
      kind: typeof n.kind === "string" ? n.kind : undefined,
      noteText: typeof n.noteText === "string" ? n.noteText : undefined,
      fields: fields.length > 0 ? fields : undefined,
      ext: asExt(n.ext),
    });
  }

  const nodeIds = new Set(nodes.map(n => n.id));

  const edges: DiagramEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (
      !isRecord(e) ||
      typeof e.id !== "string" ||
      typeof e.from !== "string" ||
      typeof e.to !== "string"
    ) {
      return {
        ok: false,
        error: "edge には文字列の id / from / to が必要です",
      };
    }
    const d = dup(e.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };
    if (!nodeIds.has(e.from))
      return {
        ok: false,
        error: `edge ${e.id} の from が存在しません: ${e.from}`,
      };
    if (!nodeIds.has(e.to))
      return { ok: false, error: `edge ${e.id} の to が存在しません: ${e.to}` };
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      label: typeof e.label === "string" ? e.label : undefined,
      ext: asExt(e.ext),
    });
  }

  const groups: DiagramGroup[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (
      !isRecord(g) ||
      typeof g.id !== "string" ||
      typeof g.label !== "string"
    ) {
      return { ok: false, error: "group には文字列の id と label が必要です" };
    }
    const d = dup(g.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };
    const members = (Array.isArray(g.nodes) ? g.nodes : []).filter(
      (m): m is string => typeof m === "string"
    );
    for (const m of members) {
      if (!nodeIds.has(m))
        return {
          ok: false,
          error: `group ${g.id} のメンバーが存在しません: ${m}`,
        };
    }
    groups.push({
      id: g.id,
      label: g.label,
      nodes: members,
      ext: asExt(g.ext),
    });
  }

  return {
    ok: true,
    model: {
      version: 1,
      type: typeof raw.type === "string" ? raw.type : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
      nodes,
      edges,
      groups,
      ext: asExt(raw.ext),
    },
  };
}
