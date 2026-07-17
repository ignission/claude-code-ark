/**
 * CanvasPane - セッション・ホワイトボード（worktree 単位で 1 枚）
 *
 * - Excalidraw は遅延チャンク（await import）でロードする
 * - scene は canvas:save でデバウンス自動保存（サーバー側 SQLite が正）
 * - 「Claude に送る」で前回送信時との diff を自然文整形し session:send 経路で送信
 * - board-bus 経由でチャットの mermaid 図を編集可能要素として受け入れる
 * - revision（軽量楽観ロック）で multi-client 競合を検出し、競合時は最新を再読込する
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
/** 保存失敗（conflict 以外）時、再試行までの待ち時間 */
const SAVE_RETRY_MS = 5000;

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
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 直近に保存済み（または読込/送信で同期済み）の serialize 結果。同一なら保存しない */
  const lastSavedSceneRef = useRef<string | null>(null);
  /** 直近に読込/保存で確認済みの revision。次の canvas:save の baseRevision に使う */
  const revisionRef = useRef<number | null>(null);
  /** canvas:save の ACK 待ちフラグ。ACK 待ち中に次のデバウンスが発火しても
   *  二重送信せず再スケジュールするための直列化ガード（F2） */
  const saveInFlightRef = useRef(false);
  /** revision 競合で reload する直前の scene を退避するバックアップ。
   *  「競合前の編集を復元」ボタンから戻せるようにする（F3） */
  const conflictBackupRef = useRef<{
    elements: unknown[];
    files: Record<string, unknown>;
  } | null>(null);
  const [initialData, setInitialData] = useState<{
    elements: unknown[];
    files?: Record<string, unknown>;
  } | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [apiReady, setApiReady] = useState(false);
  const [sendState, setSendState] = useState<
    | "idle"
    | "sending"
    | "sent"
    | "sent-conflict"
    | "sent-unpersisted"
    | "no-change"
    | "error"
  >("idle");
  /** 保存競合など、一時的にユーザーへ知らせるメッセージ */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  /** conflictBackupRef が非 null の間だけ「競合前の編集を復元」ボタンを描画する */
  const [hasConflictBackup, setHasConflictBackup] = useState(false);

  /** 現 scene を JSON 文字列化する（保存・送信共通） */
  const serializeScene = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    return JSON.stringify({
      elements: api.getSceneElements(),
      files: api.getFiles(),
    });
  }, []);

  /** revision 競合による applyReload 直前に、破棄されるローカル編集を退避する（F3） */
  const backupConflictScene = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    conflictBackupRef.current = {
      elements: [...api.getSceneElements()],
      files: api.getFiles(),
    };
    setHasConflictBackup(true);
  }, []);

  /**
   * サーバーの最新 scene を取得しエディタへ適用する。
   * revisionRef は（scene の有無に関わらず）応答の revision で更新する。
   * canvas:updated 受信時の再読込／canvas:save の conflict 解消の両方から使う。
   */
  const applyReload = useCallback(() => {
    if (!socket) return;
    socket.emit("canvas:load", worktreePath, response => {
      if (response.error) {
        console.error("ボード再読込に失敗:", response.error);
        return;
      }
      revisionRef.current = response.revision;
      // lastSentElementsRef も初回ロードと同じパース規則（null → []）で
      // 同期する。他クライアントの送信で last_sent_scene が更新された場合に
      // 反映するため（F4: これを省くと「Claude に送る」の diff が古い基準のまま残る）
      if (response.lastSentScene) {
        try {
          const lastSent = JSON.parse(response.lastSentScene) as {
            elements?: BoardElementLike[];
          };
          lastSentElementsRef.current = lastSent.elements ?? [];
        } catch (error) {
          console.error("ボード再読込の lastSentScene パースに失敗:", error);
        }
      } else {
        lastSentElementsRef.current = [];
      }
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
        dirtyRef.current = false;
      } catch (error) {
        console.error("ボード再読込のパースに失敗:", error);
      }
    });
  }, [socket, worktreePath, serializeScene]);

  // 初期ロード（worktree ごと・reloadKey インクリメントで再試行）
  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadKey): 「再試行」ボタンで effect を再実行させるための意図的な依存
  useEffect(() => {
    if (!socket) return;
    let cancelled = false;
    setLoadState("loading");
    // room 参加（canvas:updated の worktree 単位配信対象になる）はサーバー側の
    // canvas:load ハンドラーが socket.join() で行う。クライアントからは何もしない。
    socket.emit("canvas:load", worktreePath, response => {
      if (cancelled) return;
      if (response.error) {
        console.error("ボード読込に失敗:", response.error);
        setLoadState("error");
        return;
      }
      try {
        const scene = response.scene
          ? (JSON.parse(response.scene) as {
              elements?: unknown[];
              files?: Record<string, unknown>;
            })
          : null;
        const lastSent = response.lastSentScene
          ? (JSON.parse(response.lastSentScene) as {
              elements?: BoardElementLike[];
            })
          : null;
        setInitialData({
          elements: scene?.elements ?? [],
          files: scene?.files,
        });
        lastSentElementsRef.current = lastSent?.elements ?? [];
        revisionRef.current = response.revision;
        setLoadState("ready");
      } catch (error) {
        // scene が壊れている場合は空ボードにせずエラー状態にする（上書き事故防止）
        console.error("ボード scene のパースに失敗:", error);
        setLoadState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [socket, worktreePath, reloadKey]);

  // デバウンス保存（ACK 付き）
  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (saveInFlightRef.current) {
        // 前回の canvas:save の ACK 待ち中: 二重送信せず、ACK 到着後にも
        // 保存されるよう dirty を維持したまま再スケジュールする（F2）
        scheduleSave();
        return;
      }
      const scene = serializeScene();
      if (!scene || !socket) return;
      if (scene === lastSavedSceneRef.current) {
        // 実体が変わっていない onChange（updateScene 反映・pan/zoom 等）は保存しない
        dirtyRef.current = false;
        return;
      }
      saveInFlightRef.current = true;
      socket.emit(
        "canvas:save",
        { worktreePath, scene, baseRevision: revisionRef.current },
        response => {
          saveInFlightRef.current = false;
          if (response.ok) {
            lastSavedSceneRef.current = scene;
            if (response.revision !== undefined) {
              revisionRef.current = response.revision;
            }
            // ACK 待ち中にさらに編集が入っていた場合、ACK 対象の scene と
            // 現在の serialize 結果が一致する場合のみ dirty を解除する。
            // 不一致なら dirty を維持し再スケジュールして後続編集分を保存する（F2）
            const current = serializeScene();
            if (current !== null && current !== scene) {
              dirtyRef.current = true;
              scheduleSave();
            } else {
              dirtyRef.current = false;
            }
            return;
          }
          if (response.conflict) {
            console.warn(
              "canvas:save: 他クライアントの変更と競合したため最新を読み込みます"
            );
            dirtyRef.current = false;
            // reload で上書きされる前にローカル編集を退避する（F3）
            backupConflictScene();
            setSaveNotice(
              "他のクライアントの変更と競合したため最新を読み込みます（復元ボタンで直前の編集を戻せます）"
            );
            setTimeout(() => setSaveNotice(null), 3000);
            applyReload();
            return;
          }
          // 保存失敗（conflict 以外）: dirty を維持し、5 秒後に再試行する
          console.error("canvas:save failed:", response.error);
          retryTimerRef.current = setTimeout(() => {
            scheduleSave();
          }, SAVE_RETRY_MS);
        }
      );
    }, SAVE_DEBOUNCE_MS);
  }, [socket, worktreePath, serializeScene, applyReload, backupConflictScene]);

  useEffect(() => {
    return () => {
      // アンマウント時: 未保存分を即時 flush
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (dirtyRef.current && socket) {
        const scene = serializeScene();
        if (scene && scene !== lastSavedSceneRef.current) {
          // アンマウント後は state 更新できず ACK を待てないため fire-and-forget。
          // no-op コールバックはイベントのシグネチャ（ACK 必須）を満たすためだけに渡す
          socket.emit(
            "canvas:save",
            { worktreePath, scene, baseRevision: revisionRef.current },
            () => {}
          );
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

  // 他クライアントの保存: 自分が未編集なら再読込する（revisionRef も更新する）
  useEffect(() => {
    if (!socket) return;
    const handler = ({ worktreePath: updated }: { worktreePath: string }) => {
      if (updated !== worktreePath || dirtyRef.current) return;
      applyReload();
    };
    socket.on("canvas:updated", handler);
    return () => {
      socket.off("canvas:updated", handler);
    };
  }, [socket, worktreePath, applyReload]);

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
      {
        sessionId,
        worktreePath,
        text,
        scene,
        baseRevision: revisionRef.current,
      },
      response => {
        if (!response.ok) {
          // Claude への送信自体が失敗（scene の永続化には未到達）
          console.error("ボード送信に失敗:", response.error);
          setSendState("error");
          setTimeout(() => setSendState("idle"), 2000);
          return;
        }
        if (response.persisted) {
          lastSentElementsRef.current = current;
          lastSavedSceneRef.current = scene;
          if (response.revision !== undefined) {
            revisionRef.current = response.revision;
          }
          setSendState("sent");
          setTimeout(() => setSendState("idle"), 2000);
          return;
        }
        if (response.conflict) {
          // 送信自体は成功しているが、他クライアントの新しい変更と競合したため
          // scene は上書きせず最新を再読込する（lastSentElementsRef もそこで同期される）
          console.warn(
            "canvas:send-to-claude: 他クライアントの変更と競合したため最新を読み込みます"
          );
          setSendState("sent-conflict");
          // reload で上書きされる前にローカル編集を退避する（F3）
          backupConflictScene();
          applyReload();
          setTimeout(() => setSendState("idle"), 2000);
          return;
        }
        // persisted:false かつ conflict でもない = DB エラー。送信自体は成功済みなので
        // lastSentElementsRef / lastSavedSceneRef は更新しない（dirty を維持し、
        // 既存のデバウンス保存の自動再試行に委ねる。次回 diff が冗長になるのは安全側）
        console.error(
          "canvas:send-to-claude: scene の保存に失敗しました:",
          response.error
        );
        dirtyRef.current = true;
        setSendState("sent-unpersisted");
        setTimeout(() => setSendState("idle"), 2000);
      }
    );
  }, [
    socket,
    sessionId,
    worktreePath,
    serializeScene,
    applyReload,
    backupConflictScene,
  ]);

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

  // 競合前の編集を復元する（F3）: backup の elements/files を適用し、
  // dirty 扱いにして再保存をスケジュールする
  const handleRestoreConflictBackup = useCallback(() => {
    const api = apiRef.current;
    const backup = conflictBackupRef.current;
    if (!api || !backup) return;
    const fileList = Object.values(backup.files);
    if (fileList.length > 0) api.addFiles(fileList);
    api.updateScene({ elements: backup.elements });
    conflictBackupRef.current = null;
    setHasConflictBackup(false);
    scheduleSave();
  }, [scheduleSave]);

  if (loadState === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        ボードを読み込み中...
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
        <span className="text-destructive">ボードの読み込みに失敗しました</span>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          className="rounded bg-primary px-3 py-1 text-primary-foreground text-xs hover:bg-primary/90"
        >
          再試行
        </button>
      </div>
    );
  }

  if (!initialData) {
    // loadState === "ready" では常に設定済みのはずだが、型ガードとして残す
    return null;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-border border-b px-3 py-1.5">
        <span className="font-medium text-foreground text-sm">🎨 ボード</span>
        <div className="flex items-center gap-2">
          {saveNotice && (
            <span className="text-muted-foreground text-xs">{saveNotice}</span>
          )}
          {sendState === "no-change" && (
            <span className="text-muted-foreground text-xs">変更なし</span>
          )}
          {sendState === "sent" && (
            <span className="text-muted-foreground text-xs">送信しました</span>
          )}
          {sendState === "sent-conflict" && (
            <span className="text-muted-foreground text-xs">
              {
                "送信しました（他クライアントと競合したため最新を読み込みます。復元ボタンで直前の編集を戻せます）"
              }
            </span>
          )}
          {sendState === "sent-unpersisted" && (
            <span className="text-muted-foreground text-xs">
              送信しました（保存は失敗・自動再保存します）
            </span>
          )}
          {sendState === "error" && (
            <span className="text-destructive text-xs">送信に失敗しました</span>
          )}
          {hasConflictBackup && (
            <button
              type="button"
              onClick={handleRestoreConflictBackup}
              className="rounded border border-border px-2 py-1 text-foreground text-xs hover:bg-accent"
              title="競合で読み込む前に編集していた内容を復元する"
            >
              競合前の編集を復元
            </button>
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
