import {
  Check,
  CircleCheck,
  CircleX,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  McpAuthStatus,
  McpConnectionInfo,
  McpProviderCatalog,
} from "../../../shared/types";

interface McpManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: McpProviderCatalog[];
  connections: McpConnectionInfo[];
  /** 認可フロー進行中の connectionId → authorize URL (ポップアップブロック時のフォールバック表示用) */
  pendingAuthUrls: Record<string, string>;
  /**
   * connection 作成 / 再認証。
   * - options なし or connectionId 未指定: 新規 connection
   * - connectionId 指定: 既存 connection を再認証 (in-place 更新)
   */
  onConnect: (
    providerId: string,
    options?: { label?: string; connectionId?: string }
  ) => void;
  /** リモート接続時の redirect URL ペースト */
  onSubmitRedirect: (redirectUrl: string) => void;
  /** connection 削除 */
  onDisconnect: (connectionId: string) => void;
  /** 進行中フローのキャンセル */
  onAuthCancel: (connectionId: string) => void;
  /** label 変更 */
  onRename: (connectionId: string, label: string) => void;
}

function statusBadge(status: McpAuthStatus) {
  if (status === "authenticated") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-green-500/10 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">
        <CircleCheck className="size-3" />
        認証済み
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
        <RotateCcw className="size-3" />
        期限切れ
      </span>
    );
  }
  if (status === "authenticating") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
        <Plug className="size-3 animate-pulse" />
        認証中
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
      <CircleX className="size-3" />
      未認証
    </span>
  );
}

export function McpManagerDialog({
  open,
  onOpenChange,
  catalog,
  connections,
  pendingAuthUrls,
  onConnect,
  onSubmitRedirect,
  onDisconnect,
  onAuthCancel,
  onRename,
}: McpManagerDialogProps) {
  const [pendingDisconnect, setPendingDisconnect] =
    useState<McpConnectionInfo | null>(null);
  const [pastedUrl, setPastedUrl] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  /** 編集中の connection ID と label */
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    draft: string;
  } | null>(null);

  const hasAuthenticating = connections.some(
    c => c.status === "authenticating"
  );

  useEffect(() => {
    if (!hasAuthenticating) {
      setPastedUrl("");
      setPasteError(null);
    }
  }, [hasAuthenticating]);

  useEffect(() => {
    if (!open) {
      setPendingDisconnect(null);
      setPastedUrl("");
      setPasteError(null);
      setRenameTarget(null);
    }
  }, [open]);

  const handlePasteSubmit = () => {
    setPasteError(null);
    if (!pastedUrl.trim()) {
      setPasteError("URL を貼り付けてください");
      return;
    }
    onSubmitRedirect(pastedUrl.trim());
    setPastedUrl("");
  };

  const commitRename = () => {
    if (!renameTarget) return;
    const label = renameTarget.draft.trim();
    if (label) onRename(renameTarget.id, label);
    setRenameTarget(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>MCP server (Beacon)</DialogTitle>
            <DialogDescription>
              Beacon が OAuth で接続する外部 MCP server を管理します。 同じ
              provider に複数アカウントを登録できます (例: 仕事用 / 個人用)。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {catalog.map(provider => {
              const providerConnections = connections.filter(
                c => c.providerId === provider.id
              );
              return (
                <section key={provider.id} className="space-y-2">
                  <header className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{provider.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {provider.description}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onConnect(provider.id)}
                    >
                      <Plus className="size-3.5" />
                      アカウント追加
                    </Button>
                  </header>

                  {providerConnections.length === 0 ? (
                    <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                      まだ接続がありません
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {providerConnections.map(c => {
                        const isRenaming = renameTarget?.id === c.id;
                        return (
                          <li
                            key={c.id}
                            className="rounded-md border p-2.5 text-sm"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                {isRenaming ? (
                                  <Input
                                    value={renameTarget.draft}
                                    onChange={e =>
                                      setRenameTarget({
                                        id: c.id,
                                        draft: e.target.value,
                                      })
                                    }
                                    onKeyDown={e => {
                                      if (e.key === "Enter") commitRename();
                                      if (e.key === "Escape")
                                        setRenameTarget(null);
                                    }}
                                    className="h-7 text-sm"
                                    autoFocus
                                  />
                                ) : (
                                  <span className="truncate font-medium">
                                    {c.label}
                                  </span>
                                )}
                                {!isRenaming && statusBadge(c.status)}
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                {isRenaming ? (
                                  <>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={commitRename}
                                      title="保存"
                                    >
                                      <Check className="size-3.5" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => setRenameTarget(null)}
                                      title="キャンセル"
                                    >
                                      <X className="size-3.5" />
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    {(c.status === "unauthenticated" ||
                                      c.status === "expired") && (
                                      <Button
                                        size="sm"
                                        variant="default"
                                        onClick={() =>
                                          onConnect(provider.id, {
                                            connectionId: c.id,
                                          })
                                        }
                                        title="新しいトークンで認証"
                                      >
                                        <Plug className="size-3.5" />
                                        認証
                                      </Button>
                                    )}
                                    {c.status === "authenticating" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => onAuthCancel(c.id)}
                                      >
                                        キャンセル
                                      </Button>
                                    )}
                                    {c.status === "authenticated" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          onConnect(provider.id, {
                                            connectionId: c.id,
                                          })
                                        }
                                        title="再認証"
                                      >
                                        <RotateCcw className="size-3.5" />
                                        再認証
                                      </Button>
                                    )}
                                    {/* authenticating 中は DB 行が無い (synthetic) ことがあるので
                                        rename を出さない。完了後に通常表示される */}
                                    {c.status !== "authenticating" && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() =>
                                          setRenameTarget({
                                            id: c.id,
                                            draft: c.label,
                                          })
                                        }
                                        title="名前を変更"
                                      >
                                        <Pencil className="size-3.5" />
                                      </Button>
                                    )}
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => setPendingDisconnect(c)}
                                      title="削除"
                                    >
                                      <Trash2 className="size-3.5 text-destructive" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>

          {/* 認証中 (loopback callback 待ち) のときのみ表示。
              1. 認可 URL のフォールバックリンク (ポップアップブロック対策)
              2. リモート接続向けに redirect URL のペースト入力 */}
          {hasAuthenticating && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-xs">
              {/* 認可 URL リンク (新規タブを window.open で開けなかった場合の手動経路) */}
              {Object.entries(pendingAuthUrls).length > 0 && (
                <div className="space-y-1">
                  <div className="font-medium text-foreground">
                    認可ページを開く
                  </div>
                  <div className="text-muted-foreground">
                    自動で別タブが開かなかった場合は以下のリンクから開いてください。
                  </div>
                  {Object.entries(pendingAuthUrls).map(([cid, url]) => {
                    const c = connections.find(x => x.id === cid);
                    return (
                      <a
                        key={cid}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-primary hover:underline"
                      >
                        → {c?.label ?? cid} の認可ページ
                      </a>
                    );
                  })}
                </div>
              )}

              {/* paste-back: リモート接続向けの redirect URL 入力 */}
              <div className="space-y-2 border-t pt-3">
                <div className="font-medium text-foreground">
                  リモートからアクセスしている場合
                </div>
                <div className="text-muted-foreground">
                  認可後にブラウザが「http://127.0.0.1:〜」へ遷移して接続できないと表示されたら、
                  アドレスバーの URL をコピーしてここに貼り付けてください。
                </div>
                {pasteError && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-destructive">
                    {pasteError}
                  </div>
                )}
                <Input
                  value={pastedUrl}
                  onChange={e => setPastedUrl(e.target.value)}
                  placeholder="http://127.0.0.1:35971/callback?code=...&state=..."
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handlePasteSubmit();
                    }
                  }}
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handlePasteSubmit}>
                    認証を完了
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={open2 => {
          if (!open2) setPendingDisconnect(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDisconnect?.label} を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              認証済みトークンも削除されます。Beacon の稼働中セッションは
              次回起動時から接続されなくなります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDisconnect) onDisconnect(pendingDisconnect.id);
                setPendingDisconnect(null);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
