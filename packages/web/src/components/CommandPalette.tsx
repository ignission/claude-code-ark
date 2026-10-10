/**
 * CommandPalette - 名前で探して実行するパレット (PC のみ。ノーマルモードの `:`)
 *
 * セッション・図・ファイル・コマンドを 1 つの入力欄で絞り込み、Enter で実行する。
 * 打った文をそのまま今のセッションの Claude へ送る「聞く」の行を、いつも最後に置く
 * (Tab で直接送る)。候補の形と並べ方は lib/palette.ts。
 *
 * - 開くのは KeyNavLayer (`ark:palette-open`)。閉じたら `ark:palette-closed` で知らせ、
 *   KeyNavLayer がノーマルモードのフォーカスを置き直す。場所やタブを替える操作は、
 *   ここで実行せずに KeyNavLayer へ指示として返す (いる場所の記憶を食い違わせない)
 * - ファイルの一覧は、開くたびにそのセッションの worktree ぶんを 1 回だけ取り、
 *   絞り込みは手元で行う (打つたびにサーバーへ問い合わせない)
 * - 取り消せない操作 (停止・削除・再起動) は載せない。打ち間違いの Enter で消えるため
 */

import type {
  BridgeSessionStatus,
  DiagramListItem,
  FileIndexResponse,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import type { KeyNavCommand, KeyNavRegion } from "@/lib/keynav";
import {
  askItem,
  PALETTE_CLOSED_EVENT,
  PALETTE_COMMANDS,
  PALETTE_KIND_LABEL,
  PALETTE_OPEN_EVENT,
  type PaletteClosedDetail,
  type PaletteItem,
  rankPalette,
  regionAfter,
} from "@/lib/palette";
import {
  buildSessionEntries,
  sortSessionEntries,
} from "@/lib/session-sections";
import { presentStatus } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";

export interface CommandPaletteProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  sessionStatuses: Map<string, BridgeSessionStatus>;
  /** worktree のパス → 利用者が付けた表示名 */
  worktreeDisplayNames: ReadonlyMap<string, string>;
  selectedSessionId: string | null;
  listDiagrams: (worktreePath: string) => Promise<DiagramListItem[]>;
  fetchFileIndex: (sessionId: string) => Promise<FileIndexResponse>;
  onSelectSession: (sessionId: string) => void;
  onOpenDiagram: (
    sessionId: string,
    worktreePath: string,
    relPath: string
  ) => void;
  /** 打った文を、そのセッションの Claude へ送る */
  onAsk: (sessionId: string, text: string) => void;
  onOpenBoardSuggestSettings: () => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
  }, []);

  const close = useCallback((detail: PaletteClosedDetail = {}) => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent(PALETTE_CLOSED_EVENT, { detail }));
  }, []);

  if (!open) return null;
  return <PaletteBody {...props} onClose={close} />;
}

function PaletteBody({
  sessions,
  worktrees,
  repoList,
  sessionStatuses,
  worktreeDisplayNames,
  selectedSessionId,
  listDiagrams,
  fetchFileIndex,
  onSelectSession,
  onOpenDiagram,
  onAsk,
  onOpenBoardSuggestSettings,
  onClose,
}: CommandPaletteProps & { onClose: (detail?: PaletteClosedDetail) => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [diagrams, setDiagrams] = useState<DiagramListItem[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [filesNote, setFilesNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 開いた時点のセッションに固定する (開いている間に選択が替わっても、送り先を替えない)
  const [sessionId] = useState(selectedSessionId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const worktreePath = session?.worktreePath;

  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );
  const sessionItems = useMemo<PaletteItem[]>(
    () =>
      sortSessionEntries(buildSessionEntries(groupedItems, sessionStatuses))
        // 起動していない worktree は載せない (選ぶと起動が走るので、名前で飛ぶ用途と違う)
        .flatMap(entry => {
          const target = entry.session;
          if (!target) return [];
          const path = entry.worktree?.path ?? target.worktreePath;
          const branch = entry.worktree?.branch ?? getBaseName(path);
          return [
            {
              id: `session:${target.id}`,
              kind: "session" as const,
              title: worktreeDisplayNames.get(path) ?? entry.repoName,
              detail: [
                branch,
                presentStatus(entry.statusKey).label,
                target.id === sessionId ? "いまここ" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              keywords: `${entry.repoName} ${branch}`,
              action: { type: "session" as const, sessionId: target.id },
            },
          ];
        }),
    [groupedItems, sessionStatuses, worktreeDisplayNames, sessionId]
  );
  const sessionLabel =
    sessionItems.find(item => item.id === `session:${sessionId}`)?.title ?? "";

  useEffect(() => {
    if (!sessionId || !worktreePath) return;
    let stale = false;
    listDiagrams(worktreePath)
      .then(list => {
        if (!stale) setDiagrams(list);
      })
      .catch(() => {});
    fetchFileIndex(sessionId)
      .then(response => {
        if (stale) return;
        if (!response.ok) {
          setFilesNote(`ファイルの一覧を取れませんでした: ${response.error}`);
          return;
        }
        setFilePaths(response.paths);
        if (response.truncated) {
          setFilesNote(
            `ファイルが多いため、先頭の${response.paths.length.toLocaleString()}件だけを探します`
          );
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [sessionId, worktreePath, listDiagrams, fetchFileIndex]);

  const diagramItems = useMemo<PaletteItem[]>(
    () =>
      diagrams.map(diagram => ({
        id: `diagram:${diagram.relPath}`,
        kind: "diagram",
        title: diagram.displayName,
        keywords: diagram.relPath,
        action: { type: "diagram", relPath: diagram.relPath },
      })),
    [diagrams]
  );

  const items = useMemo(() => {
    const ranked = rankPalette(query, {
      sessions: sessionItems,
      diagrams: diagramItems,
      commands: PALETTE_COMMANDS,
      filePaths,
    });
    const ask = session ? askItem(query, sessionLabel) : null;
    return ask ? [...ranked, ask] : ranked;
  }, [query, sessionItems, diagramItems, filePaths, session, sessionLabel]);

  const at = Math.min(cursor, Math.max(0, items.length - 1));

  // biome-ignore lint/correctness/useExhaustiveDependencies: at が動くたびに、選んでいる行を見える位置へ寄せる
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const run = useCallback(
    (item: PaletteItem) => {
      const action = item.action;
      let command: KeyNavCommand | undefined;
      let region: KeyNavRegion | undefined = regionAfter(action);
      switch (action.type) {
        case "session":
          onSelectSession(action.sessionId);
          break;
        case "diagram":
          if (sessionId && worktreePath) {
            onOpenDiagram(sessionId, worktreePath, action.relPath);
          }
          break;
        case "file":
          // 端末・会話のリンクと同じ入口 (「ファイル」のタブで開く)
          window.postMessage(
            { type: "ark:open-file", path: action.path },
            window.location.origin
          );
          break;
        case "keynav":
          command = action.command;
          region = undefined;
          break;
        case "board-suggest-settings":
          onOpenBoardSuggestSettings();
          break;
        case "ask":
          if (sessionId) onAsk(sessionId, action.text);
          break;
      }
      onClose({
        command,
        region,
        handoff: action.type === "board-suggest-settings",
      });
    },
    [
      onAsk,
      onClose,
      onOpenBoardSuggestSettings,
      onOpenDiagram,
      onSelectSession,
      sessionId,
      worktreePath,
    ]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 変換の確定に使う Enter / Tab では実行しない
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const move = (by: number) => {
      event.preventDefault();
      if (items.length === 0) return;
      setCursor((at + by + items.length) % items.length);
    };
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      return move(1);
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      return move(-1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return onClose();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[at];
      if (item) run(item);
      return;
    }
    if (event.key === "Tab") {
      // フォーカスを外へ逃がさない。打った文があれば、そのまま Claude へ送る
      event.preventDefault();
      const ask = items.find(item => item.kind === "ask");
      if (ask) run(ask);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="コマンドパレット"
      data-keynav-ignore=""
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-6 pt-[14vh]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel flex max-h-[62vh] w-full max-w-[640px] flex-col overflow-hidden">
        <input
          // biome-ignore lint/a11y/noAutofocus: パレットは打つために開くので、開いた瞬間に入力欄へ置く
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={
            items[at] ? `command-palette-option-${at}` : undefined
          }
          aria-label="探す、または Claude に聞く"
          placeholder="セッション・ファイル・図・コマンドを探す。Tab で Claude に聞く"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          className="shrink-0 bg-transparent px-5 py-4 text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="候補"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        >
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              一致するものがありません
            </p>
          )}
          {items.map((item, index) => (
            <div
              key={item.id}
              id={`command-palette-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === at}
              className={cn(
                "flex cursor-default items-baseline gap-3 rounded-lg px-3 py-2 text-[13px]",
                index === at && "bg-well"
              )}
              onMouseMove={() => setCursor(index)}
              onMouseDown={event => {
                // 入力欄からフォーカスを奪わない
                event.preventDefault();
                run(item);
              }}
            >
              <span className="min-w-0 truncate font-medium">{item.title}</span>
              {item.detail && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {item.detail}
                </span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {PALETTE_KIND_LABEL[item.kind]}
              </span>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-4 bg-well px-5 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ 選ぶ</span>
          <span>Enter 実行</span>
          <span>Tab Claude に聞く</span>
          <span>Esc 閉じる</span>
          {filesNote && <span className="ml-auto truncate">{filesNote}</span>}
        </div>
      </div>
    </div>
  );
}
