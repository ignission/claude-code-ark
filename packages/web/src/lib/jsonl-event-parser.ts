/**
 * Claude Code の JSONL 履歴ファイルを構造化イベントに変換する。
 *
 * 入力: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl の 1 行 = 1 JSON。
 * 出力: SplitChatPane が描画する `JsonlParsedEvent` 配列。
 *
 * 含まれる情報量は tmux 画面パースとは段違いで、tool_use の input 引数全文・
 * thinking ブロック本文・tool_result の完全な出力までを保持する。
 * **会話内容の情報源はこの JSONL のみ** (チャット UI v3 の設計原則)。
 * AskUserQuestion も tool_use の input.questions / tool_result の
 * toolUseResult から構築し、tmux 画面パースは一切行わない。
 *
 * 抑制する type:
 *   - file-history-snapshot / attachment / system / last-prompt: 内部メタ。表示しない
 *   - user content "<local-command-caveat>...": Claude Code 内部メタ。表示しない
 *   - isCompactSummary: /compact の要約 (巨大テキスト)。compact-marker に変換して
 *     本文は表示しない (/compact は JSONL ファイルを切り替えず同一ファイルに
 *     要約 user レコードを挿入する)
 */

/**
 * 全 event 共通の任意プロパティ。
 *  - `timestamp`: epoch ms (パース失敗時 undefined)
 *  - `isSidechain`: subagent の対話に true。連続する true は SplitChatPane 側で
 *    1 ブロックに集約される。
 */
interface CommonEventFields {
  timestamp?: number;
  isSidechain?: boolean;
}

export type JsonlParsedEvent =
  | ({ id: string; kind: "user-input"; text: string } & CommonEventFields)
  | ({
      id: string;
      kind: "slash-command";
      name: string;
      args?: string;
    } & CommonEventFields)
  | ({ id: string; kind: "assistant-text"; text: string } & CommonEventFields)
  | ({ id: string; kind: "thinking"; text: string } & CommonEventFields)
  | ({
      id: string;
      kind: "compact-marker";
    } & CommonEventFields)
  | ({
      id: string;
      kind: "tool-call";
      tool: string;
      input: Record<string, unknown>;
      result?: string;
      /**
       * tool_result と同一レコードの `toolUseResult` フィールド (構造化 JSON)。
       * AskUserQuestion では { questions, answers } が入り、回答テキストの
       * 正規表現パースより信頼できる第一情報源になる。
       */
      structuredResult?: unknown;
      /** tool_result の is_error (AskUserQuestion の Esc 拒否などで true) */
      isError?: boolean;
      status: "running" | "done";
      toolUseId: string;
    } & CommonEventFields);

export type ToolCallEvent = Extract<JsonlParsedEvent, { kind: "tool-call" }>;

interface RawJsonlMessage {
  uuid?: string;
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  /** /compact が同一ファイルに挿入する要約レコードのフラグ */
  isCompactSummary?: boolean;
  /** tool_result レコードに併記される構造化結果 (レコードレベル) */
  toolUseResult?: unknown;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
  };
}

const SLASH_CMD_RE = /^<command-name>([^<]+)<\/command-name>/;
const SLASH_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;

function safeJsonStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 1 JSONL 行を解釈して、events に追加・既存 tool_use にマージする。
 * 状態 (toolCallByUseId) を呼び出し側に持たせることで差分パースが可能。
 *
 * - tool_use → events に新規 tool-call を push、toolCallByUseId に登録
 * - tool_result → toolCallByUseId から該当を引き、結果をマージ (events は新インスタンスに置換)
 * - その他 → events に push のみ
 *
 * イベント追加・更新は **新しい events 配列を返す** (React の参照不変性を保つため)。
 * 行が無視される場合は同じ events 参照を返す。
 */
export function mergeJsonlLine(
  events: JsonlParsedEvent[],
  toolCallByUseId: Map<string, ToolCallEvent>,
  raw: string
): JsonlParsedEvent[] {
  if (!raw) return events;
  let obj: RawJsonlMessage | null;
  try {
    obj = JSON.parse(raw) as RawJsonlMessage;
  } catch {
    return events;
  }
  if (!obj || typeof obj !== "object") return events;
  const uuid = obj.uuid ?? `${events.length}`;
  // timestamp は ISO 文字列。パース失敗時は undefined のままで OK
  const tsParsed =
    typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
  // sidechain (subagent) フラグは true のときだけ持たせる
  const sc = obj.isSidechain === true ? true : undefined;
  let next = events;
  const pushIfNew = (ev: JsonlParsedEvent) => {
    if (next === events) next = events.slice();
    next.push(ev);
  };

  if (obj.type === "user" && obj.message?.role === "user") {
    // /compact の要約レコード。本文は数十 KB の巨大テキストなので
    // user-input として描画せず、コンパクト実行マーカーに変換する
    if (obj.isCompactSummary === true) {
      pushIfNew({
        id: `${uuid}:compact`,
        kind: "compact-marker",
        timestamp: ts,
        isSidechain: sc,
      });
      return next;
    }
    const content = obj.message.content;
    if (typeof content === "string") {
      // Claude CLI が記録する内部メタ。caveat は `/clear` 等の注意書き、
      // stdout は `/compact` 等のローカル出力 (ANSI 込みでノイジー)。
      if (
        content.startsWith("<local-command-caveat>") ||
        content.startsWith("<local-command-stdout>")
      )
        return events;
      const cmdMatch = content.match(SLASH_CMD_RE);
      if (cmdMatch) {
        const argsMatch = content.match(SLASH_ARGS_RE);
        pushIfNew({
          id: `${uuid}:slash`,
          kind: "slash-command",
          name: cmdMatch[1],
          args: argsMatch?.[1] || undefined,
          timestamp: ts,
          isSidechain: sc,
        });
        return next;
      }
      pushIfNew({
        id: `${uuid}:u`,
        kind: "user-input",
        text: content,
        timestamp: ts,
        isSidechain: sc,
      });
    } else if (Array.isArray(content)) {
      // toolUseResult はレコードレベルに 1 つだけ載る。レコード内に
      // tool_result block が複数あるケース (通常は無い) では対応が曖昧に
      // なるため、1 block のときだけ適用する
      const toolResultBlocks = content.filter(
        b => b.type === "tool_result" && typeof b.tool_use_id === "string"
      );
      const structuredResult =
        toolResultBlocks.length === 1 ? obj.toolUseResult : undefined;
      let idx = 0;
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          pushIfNew({
            id: `${uuid}:u:${idx}`,
            kind: "user-input",
            text: block.text,
            timestamp: ts,
            isSidechain: sc,
          });
        } else if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          const target = toolCallByUseId.get(block.tool_use_id);
          if (target) {
            // 既存 tool-call を結果付きの新インスタンスに置換する。
            // events 配列内も新インスタンスに差し替えて React の比較が確実に効くようにする。
            const updated: ToolCallEvent = {
              ...target,
              result: safeJsonStringify(block.content),
              structuredResult,
              isError: block.is_error === true ? true : undefined,
              status: "done" as const,
            };
            toolCallByUseId.set(block.tool_use_id, updated);
            if (next === events) next = events.slice();
            const at = next.indexOf(target);
            if (at >= 0) next[at] = updated;
          }
        }
        idx++;
      }
    }
  } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      let idx = 0;
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          pushIfNew({
            id: `${uuid}:a:${idx}`,
            kind: "assistant-text",
            text: block.text,
            timestamp: ts,
            isSidechain: sc,
          });
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          pushIfNew({
            id: `${uuid}:th:${idx}`,
            kind: "thinking",
            text: block.thinking,
            timestamp: ts,
            isSidechain: sc,
          });
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const e: ToolCallEvent = {
            id: block.id,
            kind: "tool-call",
            tool: block.name,
            input: block.input ?? {},
            status: "running",
            toolUseId: block.id,
            timestamp: ts,
            isSidechain: sc,
          };
          pushIfNew(e);
          toolCallByUseId.set(block.id, e);
        }
        idx++;
      }
    }
  }
  // file-history-snapshot, attachment, system, last-prompt は無視

  return next;
}

/**
 * 複数行をまとめてパースする (snapshot 用)。
 * 内部状態を持たないので毎回新規 Map を作る。
 */
export function parseJsonlEvents(lines: string[]): JsonlParsedEvent[] {
  const toolCallByUseId = new Map<string, ToolCallEvent>();
  let events: JsonlParsedEvent[] = [];
  for (const raw of lines) {
    events = mergeJsonlLine(events, toolCallByUseId, raw);
  }
  return events;
}
