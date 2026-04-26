import { ArrowUp, Folder, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/useMobile";
import type { FsListResult } from "../../../shared/types";

interface FolderBrowserDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** 初期表示パス（未指定時はサーバー側でホームディレクトリ） */
  initialPath?: string;
  /** ダイアログタイトル */
  title?: string;
  /** ダイアログの説明 */
  description?: string;
  /** ディレクトリ列挙関数（useSocket.listDirectory） */
  listDirectory: (path?: string) => Promise<FsListResult>;
  /** 「選択」押下時のコールバック */
  onConfirm: (path: string) => void;
}

function FolderBrowserContent({
  variant,
  initialPath,
  description,
  listDirectory,
  onConfirm,
  onClose,
}: {
  variant: "dialog" | "drawer";
  initialPath?: string;
  description?: string;
  listDirectory: (path?: string) => Promise<FsListResult>;
  onConfirm: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // パス入力は編集中のdraftを別持ちし、keystrokeごとにloadしない。
  // Enter / blurで確定したときだけload。中間パスの解決失敗でスナップバックを防ぐ。
  const [pathDraft, setPathDraft] = useState("");

  const load = useCallback(
    async (targetPath?: string) => {
      setError(null);
      setIsLoading(true);
      try {
        const res = await listDirectory(targetPath);
        setListing(res);
        setPathDraft(res.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [listDirectory]
  );

  useEffect(() => {
    void load(initialPath);
  }, [load, initialPath]);

  const visibleEntries = (listing?.entries ?? []).filter(
    e => showHidden || !e.isHidden
  );

  // エラー発生時はconfirm不可。listingは前回値が残るため
  // pathDraft（テキスト欄表示）と乖離したまま誤選択するのを防ぐ。
  const isConfirmDisabled = !listing || error !== null;

  const handleConfirm = () => {
    if (isConfirmDisabled || !listing) return;
    onConfirm(listing.path);
    onClose();
  };

  const isDrawer = variant === "drawer";

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden px-1 py-2">
      {description && (
        <p className="px-1 text-xs text-muted-foreground">{description}</p>
      )}

      {/* パス入力 + 親ディレクトリへ移動 */}
      <div className="flex gap-2 px-1">
        <Input
          value={pathDraft}
          onChange={e => setPathDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              void load(pathDraft);
            } else if (e.key === "Escape") {
              setPathDraft(listing?.path ?? "");
            }
          }}
          onBlur={() => {
            if (pathDraft && pathDraft !== listing?.path) {
              void load(pathDraft);
            }
          }}
          placeholder="/path/to/directory"
          className="h-12 flex-1 font-mono text-base md:h-10 md:text-sm"
          aria-label="現在のパス"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => listing?.parent && void load(listing.parent)}
          disabled={isLoading || !listing || listing.parent === null}
          className="h-12 shrink-0 md:h-10"
          aria-label="親ディレクトリへ移動"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void load(listing?.path)}
          disabled={isLoading}
          className="h-12 shrink-0 md:h-10"
          aria-label="再読み込み"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mx-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      {/* ディレクトリ一覧 */}
      <div
        className={`mx-1 flex-1 overflow-y-auto rounded-md border ${
          isDrawer ? "min-h-[200px]" : "min-h-[260px] max-h-[360px]"
        } ${isLoading ? "opacity-50" : ""}`}
      >
        <div className="space-y-0.5 p-2">
          {listing === null && isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              読み込み中…
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {(listing?.entries.length ?? 0) > 0
                ? "隠しフォルダのみ（下のチェックボックスで表示）"
                : "サブフォルダなし"}
            </div>
          ) : (
            visibleEntries.map(entry => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void load(entry.path)}
                disabled={isLoading}
                className={`flex w-full items-center gap-2 rounded-md text-left transition-colors hover:bg-accent ${
                  isDrawer ? "min-h-[44px] p-3" : "p-2"
                }`}
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{entry.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* 隠しフォルダ表示トグル */}
      <div className="flex items-center gap-2 px-2">
        <Checkbox
          id="folder-browser-show-hidden"
          checked={showHidden}
          onCheckedChange={checked => setShowHidden(checked === true)}
        />
        <Label
          htmlFor="folder-browser-show-hidden"
          className="cursor-pointer text-xs text-muted-foreground"
        >
          隠しフォルダを表示
        </Label>
      </div>

      {/* フッター */}
      {isDrawer ? (
        <DrawerFooter className="px-1 pb-2">
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className="glow-green h-12"
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            このフォルダを選択
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="h-12"
          >
            キャンセル
          </Button>
        </DrawerFooter>
      ) : (
        <DialogFooter className="px-1 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className="glow-green"
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            このフォルダを選択
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

function FolderBrowserDesktop(props: FolderBrowserDialogProps) {
  return (
    <Dialog open={props.isOpen} onOpenChange={props.onOpenChange}>
      <DialogContent className="mx-auto flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col bg-card">
        <DialogHeader>
          <DialogTitle>{props.title ?? "フォルダを選択"}</DialogTitle>
          <DialogDescription>
            {props.description ??
              "ディレクトリを移動して、選択したいフォルダを開いた状態で「このフォルダを選択」を押してください。"}
          </DialogDescription>
        </DialogHeader>
        <FolderBrowserContent
          variant="dialog"
          initialPath={props.initialPath}
          listDirectory={props.listDirectory}
          onConfirm={props.onConfirm}
          onClose={() => props.onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function FolderBrowserMobile(props: FolderBrowserDialogProps) {
  return (
    <Drawer open={props.isOpen} onOpenChange={props.onOpenChange}>
      <DrawerContent className="flex max-h-[90dvh] flex-col">
        <DrawerHeader>
          <DrawerTitle>{props.title ?? "フォルダを選択"}</DrawerTitle>
          <DrawerDescription>
            {props.description ??
              "ディレクトリを移動して、選択したいフォルダを開いた状態で「このフォルダを選択」を押してください。"}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-1 flex-col overflow-hidden px-4">
          <FolderBrowserContent
            variant="drawer"
            initialPath={props.initialPath}
            listDirectory={props.listDirectory}
            onConfirm={props.onConfirm}
            onClose={() => props.onOpenChange(false)}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function FolderBrowserDialog(props: FolderBrowserDialogProps) {
  const isMobile = useIsMobile();
  if (isMobile) return <FolderBrowserMobile {...props} />;
  return <FolderBrowserDesktop {...props} />;
}
