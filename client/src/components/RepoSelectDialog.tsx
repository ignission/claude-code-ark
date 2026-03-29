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
import type { RepoInfo } from "../../../shared/types";

interface RepoSelectDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  onScanRepos: (basePath: string) => void;
  onSelectRepo: (path: string) => void;
}

// --- 共通コンテンツ ---
function RepoSelectContent({
  variant,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
  onOpenChange,
}: {
  variant: "dialog" | "drawer";
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  onScanRepos: (basePath: string) => void;
  onSelectRepo: (path: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [scanBasePath, setScanBasePath] = useState(() => {
    return localStorage.getItem("scanBasePath") || "";
  });
  const [repoInput, setRepoInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");

  const filteredRepos = useMemo(() => {
    if (!filterQuery.trim()) {
      return scannedRepos;
    }
    const query = filterQuery.toLowerCase();
    return scannedRepos.filter(
      repo =>
        repo.name.toLowerCase().includes(query) ||
        repo.path.toLowerCase().includes(query)
    );
  }, [scannedRepos, filterQuery]);

  useEffect(() => {
    if (scanBasePath) {
      localStorage.setItem("scanBasePath", scanBasePath);
    }
  }, [scanBasePath]);

  const handleScanRepos = () => {
    if (!scanBasePath.trim()) return;
    onScanRepos(scanBasePath.trim());
  };

  const handleSelectRepo = () => {
    if (!repoInput.trim()) return;
    onSelectRepo(repoInput.trim());
    onOpenChange(false);
  };

  const isDrawer = variant === "drawer";

  return (
    <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
      {/* スキャン用入力 */}
      <div className="space-y-2 px-1">
        <Label htmlFor="scanPath">スキャンするパス</Label>
        <div className="flex gap-2">
          <Input
            id="scanPath"
            placeholder="/Users/username/dev"
            value={scanBasePath}
            onChange={e => setScanBasePath(e.target.value)}
            autoFocus={!isDrawer}
            onKeyDown={e => {
              if (e.key === "Enter") handleScanRepos();
            }}
            className="font-mono h-12 md:h-10 text-base md:text-sm flex-1"
          />
          <Button
            type="button"
            onClick={handleScanRepos}
            disabled={isScanning}
            className="h-12 md:h-10 shrink-0"
          >
            {isScanning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              "スキャン"
            )}
          </Button>
        </div>
      </div>

      {/* スキャン結果リスト */}
      <div className="space-y-2 flex-1 overflow-hidden flex flex-col px-1">
        <Label>
          {isScanning
            ? "スキャン中..."
            : scannedRepos.length > 0
              ? `検出されたリポジトリ (${filteredRepos.length}/${scannedRepos.length})`
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
            disabled={isScanning || scannedRepos.length === 0}
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
    </div>
  );
}

// --- デスクトップ版: Dialog ---
function RepoSelectDialogDesktop({
  isOpen,
  onOpenChange,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
}: RepoSelectDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-lg mx-auto max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>リポジトリを選択</DialogTitle>
          <DialogDescription>
            ディレクトリパスを入力してスキャンするか、直接リポジトリパスを入力してください。
          </DialogDescription>
        </DialogHeader>
        <RepoSelectContent
          variant="dialog"
          scannedRepos={scannedRepos}
          isScanning={isScanning}
          onScanRepos={onScanRepos}
          onSelectRepo={onSelectRepo}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

// --- モバイル版: Drawer ---
function RepoSelectDrawerMobile({
  isOpen,
  onOpenChange,
  scannedRepos,
  isScanning,
  onScanRepos,
  onSelectRepo,
}: RepoSelectDialogProps) {
  return (
    <Drawer open={isOpen} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh] flex flex-col">
        <DrawerHeader>
          <DrawerTitle>リポジトリを選択</DrawerTitle>
          <DrawerDescription>
            ディレクトリパスを入力してスキャンするか、直接リポジトリパスを入力してください。
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex-1 overflow-hidden flex flex-col px-4">
          <RepoSelectContent
            variant="drawer"
            scannedRepos={scannedRepos}
            isScanning={isScanning}
            onScanRepos={onScanRepos}
            onSelectRepo={onSelectRepo}
            onOpenChange={onOpenChange}
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
