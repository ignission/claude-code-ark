/**
 * CanvasPane - セッション・ホワイトボード（worktree 単位で 1 枚）
 *
 * - Excalidraw は遅延チャンク（await import）でロードする
 * - scene は canvas:save でデバウンス自動保存（サーバー側 SQLite が正）
 * - 「Claude に送る」で前回送信時との diff を自然文整形し session:send 経路で送信
 * - board-bus 経由でチャットの mermaid 図を編集可能要素として受け入れる
 */
import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Socket } from "socket.io-client";
import { subscribeBoardInserts } from "../lib/board-bus";
import {
  type BoardElementLike,
  buildBoardDiffText,
} from "../lib/canvas-diff-utils";
import {
  computeInsertOffset,
  convertMermaidForBoard,
} from "../lib/mermaid-to-board";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 使用する Excalidraw API の最小面（バージョン固有の型 export 経路に依存しない） */
interface ExcalidrawApiLike {
  getSceneElements(): readonly BoardElementLike[];
  getFiles(): Record<string, unknown>;
  updateScene(scene: { elements: unknown[] }): void;
  addFiles(files: unknown[]): void;
}

const ExcalidrawLazy = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  await import("@excalidraw/excalidraw/index.css");
  return { default: mod.Excalidraw };
});

const SAVE_DEBOUNCE_MS = 1000;

interface CanvasPaneProps {
  socket: TypedSocket | null;
  sessionId: string;
  worktreePath: string;
}

export function CanvasPane({
  socket,
  sessionId,
  worktreePath,
}: CanvasPaneProps) {
  const apiRef = useRef<ExcalidrawApiLike | null>(null);
  const lastSentElementsRef = useRef<BoardElementLike[]>([]);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 直近に保存済み（または読込/送信で同期済み）の serialize 結果。同一なら保存しない */
  const lastSavedSceneRef = useRef<string | null>(null);
  const [initialData, setInitialData] = useState<{
    elements: unknown[];
    files?: Record<string, unknown>;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const [sendState, setSendState] = useState<
    "idle" | "sending" | "sent" | "no-change" | "error"
  >("idle");

  /** 現 scene を JSON 文字列化する（保存・送信共通） */
  const serializeScene = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    return JSON.stringify({
      elements: api.getSceneElements(),
      files: api.getFiles(),
    });
  }, []);

  // 初期ロード（worktree ごとに 1 回）
  useEffect(() => {
    if (!socket) return;
    setLoaded(false);
    socket.emit("canvas:load", worktreePath, response => {
      try {
        const scene = response.scene
          ? (JSON.parse(response.scene) as {
              elements?: unknown[];
              files?: Record<string, unknown>;
            })
          : null;
        setInitialData({
          elements: scene?.elements ?? [],
          files: scene?.files,
        });
        const lastSent = response.lastSentScene
          ? (JSON.parse(response.lastSentScene) as {
              elements?: BoardElementLike[];
            })
          : null;
        lastSentElementsRef.current = lastSent?.elements ?? [];
      } catch {
        // 壊れた scene は空ボードとして開く（保存で上書きされる）
        setInitialData({ elements: [] });
        lastSentElementsRef.current = [];
      }
      setLoaded(true);
    });
  }, [socket, worktreePath]);

  // デバウンス保存
  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const scene = serializeScene();
      if (!scene || !socket) return;
      if (scene === lastSavedSceneRef.current) {
        // 実体が変わっていない onChange（updateScene 反映・pan/zoom 等）は保存しない
        dirtyRef.current = false;
        return;
      }
      socket.emit("canvas:save", { worktreePath, scene });
      lastSavedSceneRef.current = scene;
      dirtyRef.current = false;
    }, SAVE_DEBOUNCE_MS);
  }, [socket, worktreePath, serializeScene]);

  useEffect(() => {
    return () => {
      // アンマウント時: 未保存分を即時 flush
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && socket) {
        const scene = serializeScene();
        if (scene && scene !== lastSavedSceneRef.current) {
          socket.emit("canvas:save", { worktreePath, scene });
        }
      }
    };
  }, [socket, worktreePath, serializeScene]);

  // board-bus: mermaid 挿入依頼を購読する。
  // 購読は Excalidraw API の準備完了後に開始する — 初回マウント時は API 準備前に
  // キューの flush が走るため、ここでゲートしないと挿入依頼が無音で消える。
  // 購読前の依頼は board-bus 側のキューに滞留し、購読開始時に flush される。
  useEffect(() => {
    if (!apiReady) return;
    return subscribeBoardInserts(worktreePath, async insert => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const { elements, files } = await convertMermaidForBoard(insert.code);
        const existing = api.getSceneElements();
        const offsetX = computeInsertOffset(
          existing.map(el => ({ x: el.x, width: el.width }))
        );
        const shifted = (elements as Array<Record<string, unknown>>).map(
          el => ({
            ...el,
            x: ((el.x as number) ?? 0) + offsetX,
          })
        );
        const fileList = Object.values(files);
        if (fileList.length > 0) api.addFiles(fileList);
        api.updateScene({ elements: [...existing, ...shifted] });
        scheduleSave();
      } catch (error) {
        console.error("ボードへの図の挿入に失敗:", error);
      }
    });
  }, [apiReady, worktreePath, scheduleSave]);

  // 他クライアントの保存: 自分が未編集なら再読込
  useEffect(() => {
    if (!socket) return;
    const handler = ({ worktreePath: updated }: { worktreePath: string }) => {
      if (updated !== worktreePath || dirtyRef.current) return;
      socket.emit("canvas:load", worktreePath, response => {
        const api = apiRef.current;
        if (!api || !response.scene) return;
        try {
          const scene = JSON.parse(response.scene) as {
            elements?: unknown[];
            files?: Record<string, unknown>;
          };
          if (scene.files) api.addFiles(Object.values(scene.files));
          api.updateScene({ elements: scene.elements ?? [] });
          lastSavedSceneRef.current = serializeScene();
        } catch {
          // 壊れた scene は無視
        }
      });
    };
    socket.on("canvas:updated", handler);
    return () => {
      socket.off("canvas:updated", handler);
    };
  }, [socket, worktreePath, serializeScene]);

  // Claude に送る
  const handleSend = useCallback(() => {
    const api = apiRef.current;
    if (!api || !socket) return;
    const current = [...api.getSceneElements()];
    const text = buildBoardDiffText(lastSentElementsRef.current, current);
    if (!text) {
      setSendState("no-change");
      setTimeout(() => setSendState("idle"), 2000);
      return;
    }
    const scene = serializeScene();
    if (!scene) return;
    setSendState("sending");
    socket.emit(
      "canvas:send-to-claude",
      { sessionId, worktreePath, text, scene },
      response => {
        if (response.ok) {
          lastSentElementsRef.current = current;
          lastSavedSceneRef.current = scene;
          setSendState("sent");
        } else {
          console.error("ボード送信に失敗:", response.error);
          setSendState("error");
        }
        setTimeout(() => setSendState("idle"), 2000);
      }
    );
  }, [socket, sessionId, worktreePath, serializeScene]);

  // Excalidraw API の受け取り。準備完了を state で追跡し、board-bus 購読の
  // ゲートに使う（購読開始前に api が使えないと挿入依頼が無音で消えるため）。
  // biome-ignore lint/suspicious/noExplicitAny: バージョン固有の型 export 経路に依存しないため最小面へ cast
  const handleExcalidrawApi = useCallback((api: any) => {
    apiRef.current = api as ExcalidrawApiLike;
    // 読込直後の状態を保存基準にする（pan/zoom だけで保存が走るのを防ぐ）
    lastSavedSceneRef.current = JSON.stringify({
      elements: (api as ExcalidrawApiLike).getSceneElements(),
      files: (api as ExcalidrawApiLike).getFiles(),
    });
    setApiReady(true);
  }, []);

  if (!loaded || !initialData) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        ボードを読み込み中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-border border-b px-3 py-1.5">
        <span className="font-medium text-foreground text-sm">🎨 ボード</span>
        <div className="flex items-center gap-2">
          {sendState === "no-change" && (
            <span className="text-muted-foreground text-xs">変更なし</span>
          )}
          {sendState === "sent" && (
            <span className="text-muted-foreground text-xs">送信しました</span>
          )}
          {sendState === "error" && (
            <span className="text-destructive text-xs">送信に失敗しました</span>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={!apiReady || sendState === "sending"}
            className="rounded bg-primary px-2 py-1 text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
            title="前回送信以降のボード変更を Claude に伝える"
          >
            {sendState === "sending" ? "送信中..." : "Claude に送る"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              エディタを読み込み中...
            </div>
          }
        >
          <ExcalidrawLazy
            excalidrawAPI={handleExcalidrawApi}
            initialData={initialData as never}
            onChange={scheduleSave}
          />
        </Suspense>
      </div>
    </div>
  );
}
