import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { ArrowUpRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { createFileApi } from "@/lib/file-api";
import { type FileTab, fileTabKind } from "@/lib/file-tabs";
import { FileEditor } from "./FileEditor";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 図のリンクから開いた 1 件。seq は開くたびに増える (同じパスの開き直しでも増える) */
export interface FilePeekTarget {
  filePath: string;
  targetLine?: number | null;
  targetEndLine?: number | null;
  seq: number;
}

interface FilePeekProps {
  socket: TypedSocket | null;
  sessionId: string;
  peek: FilePeekTarget;
  /** 実際に見えているか (作業エリアが開いていて、図のタブで、セッションが選択中) */
  isVisible: boolean;
  onClose: () => void;
  /**
   * 「ファイル」のタブで開き直す。引数は今見せているピーク
   * (差し替えを断ったあとは、親が持つ peek と食い違うことがある)
   */
  onPromote: (peek: FilePeekTarget) => void;
}

const CONFIRM_DISCARD = "保存していない変更があります。閉じますか？";

const HEADER_BUTTON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground";

/**
 * ピーク。図のコードリンクを踏んだとき、図を見たままその横にコードを出す。
 * 中身は「ファイル」のタブと同じ FileEditor で、編集も保存もできる。
 * 開けるのは 1 件だけで、別のリンクを踏むと差し替わる。リロードでは復元しない
 */
export function FilePeek({
  socket,
  sessionId,
  peek,
  isVisible,
  onClose,
  onPromote,
}: FilePeekProps) {
  // FileEditor は api の同一性で読み直すので、作り直しを最小にする
  const api = useMemo(
    () => (socket ? createFileApi(socket, sessionId) : null),
    [socket, sessionId]
  );
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const handleDirtyChange = useCallback((_tabId: string, next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);
  const handleSaved = useCallback(() => {}, []);

  // 見せているパスは props から直接は取らない。未保存のまま別のパスへ差し替えると
  // エディタごと編集が消えるので、確認してから切り替える (確認は描画中に出せない)
  const [shown, setShown] = useState(peek);
  /** 差し替えを断った seq。同じ依頼で 2 度は聞かない */
  const declinedSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (peek.filePath === shown.filePath) return;
    if (declinedSeqRef.current === peek.seq) return;
    if (dirtyRef.current && !window.confirm(CONFIRM_DISCARD)) {
      declinedSeqRef.current = peek.seq;
      return;
    }
    setShown(peek);
  }, [peek, shown.filePath]);
  // 同じパスの開き直しは、確認なしで行だけ追従する
  const displayed = peek.filePath === shown.filePath ? peek : shown;

  // 未保存があるままページを離れるときに確認する (FilePane と同じ)
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 古いブラウザは returnValue を見る
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const { filePath, targetLine, targetEndLine, seq } = displayed;
  const tab = useMemo<FileTab>(
    () => ({
      id: `peek:${filePath}`,
      kind: fileTabKind(filePath),
      filePath,
      targetLine,
      targetEndLine,
      revealSeq: seq,
    }),
    [filePath, targetLine, targetEndLine, seq]
  );

  const confirmDiscard = () =>
    !dirtyRef.current || window.confirm(CONFIRM_DISCARD);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-border border-b bg-muted/30 pr-1.5 pl-3">
        <span className="shrink-0 font-semibold text-[11px] text-muted-foreground tracking-[0.08em]">
          PEEK
        </span>
        <span
          className="min-w-0 flex-1 truncate text-foreground text-xs"
          title={filePath}
        >
          {filePath}
        </span>
        <button
          type="button"
          aria-label="ファイルで開く"
          title="ファイルで開く"
          onClick={() => {
            if (confirmDiscard()) onPromote(displayed);
          }}
          className={HEADER_BUTTON}
        >
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="ピークを閉じる"
          title="ピークを閉じる"
          onClick={() => {
            if (confirmDiscard()) onClose();
          }}
          className={HEADER_BUTTON}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {api ? (
          // パスが変わったら作り直す (前のファイルの編集と undo 履歴を持ち越さない)
          <FileEditor
            key={filePath}
            api={api}
            tab={tab}
            isVisible={isVisible}
            onDirtyChange={handleDirtyChange}
            onSaved={handleSaved}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
            接続中…
          </div>
        )}
      </div>
    </div>
  );
}
