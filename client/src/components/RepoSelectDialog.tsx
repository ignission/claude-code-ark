import { FolderOpen, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useIsMobile } from "@/hooks/useMobile";
import type { FsListResult, RepoInfo } from "../../../shared/types";
import { FolderBrowserDialog } from "./FolderBrowserDialog";

interface RepoSelectDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** `--repos` 起動オプション由来の許可リポジトリ一覧。空配列なら制限なし */
  allowedRepos: string[];
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  onScanRepos: (basePath: string) => void;
  onSelectRepo: (path: string) => void;
  listDirectory: (path?: string) => Promise<FsListResult>;
  /**
   * 前回スキャンしたパス（サーバーDB由来、クロスデバイス共有）。
   * 失敗パスを保存しないため、保存はサーバー側のスキャン成功時のみで行われる。
   */
  initialScanBasePath: string;
}

// --- 共通コンテンツ ---
function RepoSelectContent({
  variant,
  allowedRepos,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
  onOpenChange,
  listDirectory,
  initialScanBasePath,
}: {
  variant: "dialog" | "drawer";
  allowedRepos: string[];
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  onScanRepos: (basePath: string) => void;
  onSelectRepo: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  listDirectory: (path?: string) => Promise<FsListResult>;
  initialScanBasePath: string;
}) {
  const [scanBasePath, setScanBasePath] = useState(initialScanBasePath);
  const [repoInput, setRepoInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);

  // ダイアログを開き直したときに最新のサーバー値を反映
  useEffect(() => {
    setScanBasePath(initialScanBasePath);
  }, [initialScanBasePath]);

  // allowlistモード: --reposで起動したサーバーは任意ディレクトリ列挙を拒否するため、
  // フォルダ選択UIを非表示にし、許可リポジトリ一覧のみ提示する
  const isAllowlistMode = allowedRepos.length > 0;

  // 表示するリポジトリ一覧: allowlistモードでは許可リポジトリ、通常モードではスキャン結果
  const displayRepos = useMemo<RepoInfo[]>(() => {
    if (isAllowlistMode) {
      return allowedRepos.map(p => ({
        path: p,
        name: p.split("/").filter(Boolean).pop() ?? p,
        branch: "",
      }));
    }
    return scannedRepos;
  }, [isAllowlistMode, allowedRepos, scannedRepos]);

  const filteredRepos = useMemo(() => {
    if (!filterQuery.trim()) {
      return displayRepos;
    }
    const query = filterQuery.toLowerCase();
    return displayRepos.filter(
      repo =>
        repo.name.toLowerCase().includes(query) ||
        repo.path.toLowerCase().includes(query)
    );
  }, [displayRepos, filterQuery]);

  const handleSelectRepo = () => {
    if (!repoInput.trim()) return;
    onSelectRepo(repoInput.trim());
    onOpenChange(false);
  };

  // scanBasePath はサーバー側のスキャン成功時のみDBに永続化される（失敗パスを残さないため）。
  // クライアント側ではローカルstateだけ更新し、本セッション中の表示用に保持する。
  const handleFolderConfirm = (path: string) => {
    setScanBasePath(path);
    onScanRepos(path);
  };

  const isDrawer = variant === "drawer";

  return (
    <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
      {/* スキャンパス選択（allowlistモード時は任意パス列挙が拒否されるため非表示） */}
      {!isAllowlistMode && (
        <div className="space-y-2 px-1">
          <Label>スキャンするパス</Label>
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsFolderBrowserOpen(true)}
            disabled={isScanning}
            className="w-full justify-start gap-2 h-12 md:h-10 font-mono text-base md:text-sm"
          >
            {isScanning ? (
              <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
            ) : (
              <FolderOpen className="w-4 h-4 shrink-0" />
            )}
            <span className="truncate flex-1 text-left">
              {scanBasePath || "フォルダを選択..."}
            </span>
          </Button>
        </div>
      )}

      {/* リポジトリ一覧 */}
      <div className="space-y-2 flex-1 overflow-hidden flex flex-col px-1">
        <Label>
          {isAllowlistMode
            ? `許可されたリポジトリ (${filteredRepos.length}/${displayRepos.length})`
            : isScanning
              ? "スキャン中..."
              : displayRepos.length > 0
                ? `検出されたリポジトリ (${filteredRepos.length}/${displayRepos.length})`
                : "検出されたリポジトリ"}
        </Label>
        {/* 検索ボックス */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="リポジトリを検索..."
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
            className="pl-9 h-10"
            disabled={isScanning || displayRepos.length === 0}
          />
        </div>
        <div
          className={`flex-1 border rounded-md overflow-y-auto ${
            isDrawer ? "min-h-[120px]" : "min-h-[200px] max-h-[300px]"
          } ${isScanning ? "opacity-50" : ""}`}
        >
          <div className="p-2 space-y-1">
            {filteredRepos.map(repo => (
              <div
                key={repo.path}
                className={`rounded-md cursor-pointer transition-colors ${
                  isDrawer
                    ? "p-4 min-h-[44px] hover:bg-accent active:bg-accent/80"
                    : "p-3 hover:bg-accent"
                }`}
                onClick={() => {
                  onSelectRepo(repo.path);
                  onOpenChange(false);
                }}
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="font-medium text-sm truncate">
                    {repo.name}
                  </span>
                  {repo.branch && (
                    <span className="text-xs text-muted-foreground">
                      ({repo.branch})
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground font-mono mt-1 truncate pl-6">
                  {repo.path}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Separator />

      {/* 直接パス入力 */}
      <div className="space-y-2 px-1">
        <Label htmlFor="repoPath">または直接パスを入力</Label>
        <Input
          id="repoPath"
          placeholder="/path/to/your/repository"
          value={repoInput}
          onChange={e => setRepoInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") handleSelectRepo();
          }}
          className="font-mono h-12 md:h-10 text-base md:text-sm"
        />
      </div>

      {/* フッター */}
      {isDrawer ? (
        <div className="flex flex-col gap-2 pt-2 px-1">
          <Button
            type="button"
            onClick={handleSelectRepo}
            disabled={!repoInput.trim()}
            className="glow-green h-12"
          >
            選択
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12"
          >
            キャンセル
          </Button>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end pt-2 px-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-12 md:h-10"
          >
            キャンセル
          </Button>
          <Button
            type="button"
            onClick={handleSelectRepo}
            disabled={!repoInput.trim()}
            className="glow-green h-12 md:h-10"
          >
            選択
          </Button>
        </div>
      )}

      {/* フォルダ選択ダイアログ */}
      <FolderBrowserDialog
        isOpen={isFolderBrowserOpen}
        onOpenChange={setIsFolderBrowserOpen}
        initialPath={scanBasePath || undefined}
        title="スキャンするフォルダを選択"
        description="このフォルダ配下のGitリポジトリをスキャンします。"
        listDirectory={listDirectory}
        onConfirm={handleFolderConfirm}
      />
    </div>
  );
}

// --- デスクトップ版: Dialog ---
function RepoSelectDialogDesktop({
  isOpen,
  onOpenChange,
  allowedRepos,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
  listDirectory,
  initialScanBasePath,
}: RepoSelectDialogProps) {
  const isAllowlistMode = allowedRepos.length > 0;
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-lg mx-auto max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>リポジトリを選択</DialogTitle>
          <DialogDescription>
            {isAllowlistMode
              ? "許可されたリポジトリ一覧から選択するか、直接リポジトリパスを入力してください。"
              : "スキャンするフォルダを選択するか、直接リポジトリパスを入力してください。"}
          </DialogDescription>
        </DialogHeader>
        <RepoSelectContent
          variant="dialog"
          allowedRepos={allowedRepos}
          scannedRepos={scannedRepos}
          isScanning={isScanning}
          onScanRepos={onScanRepos}
          onSelectRepo={onSelectRepo}
          onOpenChange={onOpenChange}
          listDirectory={listDirectory}
          initialScanBasePath={initialScanBasePath}
        />
      </DialogContent>
    </Dialog>
  );
}

// --- モバイル版: Drawer ---
function RepoSelectDrawerMobile({
  isOpen,
  onOpenChange,
  allowedRepos,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
  listDirectory,
  initialScanBasePath,
}: RepoSelectDialogProps) {
  const isAllowlistMode = allowedRepos.length > 0;
  return (
    <Drawer open={isOpen} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh] flex flex-col">
        <DrawerHeader>
          <DrawerTitle>リポジトリを選択</DrawerTitle>
          <DrawerDescription>
            {isAllowlistMode
              ? "許可されたリポジトリ一覧から選択するか、直接リポジトリパスを入力してください。"
              : "スキャンするフォルダを選択するか、直接リポジトリパスを入力してください。"}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex-1 overflow-hidden flex flex-col px-4">
          <RepoSelectContent
            variant="drawer"
            allowedRepos={allowedRepos}
            scannedRepos={scannedRepos}
            isScanning={isScanning}
            onScanRepos={onScanRepos}
            onSelectRepo={onSelectRepo}
            onOpenChange={onOpenChange}
            listDirectory={listDirectory}
            initialScanBasePath={initialScanBasePath}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// --- エントリーポイント ---
export function RepoSelectDialog(props: RepoSelectDialogProps) {
  const isMobile = useIsMobile();
  if (isMobile) return <RepoSelectDrawerMobile {...props} />;
  return <RepoSelectDialogDesktop {...props} />;
}
