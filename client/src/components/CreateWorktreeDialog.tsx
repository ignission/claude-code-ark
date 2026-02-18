import { useState, useCallback, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedRepoPath: string | null;
  onCreateWorktree: (branchName: string, baseBranch?: string) => void;
}

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  selectedRepoPath,
  onCreateWorktree,
}: CreateWorktreeDialogProps) {
  const [newBranchName, setNewBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");

  // ダイアログを閉じるときに状態をリセット
  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setNewBranchName("");
      setBaseBranch("");
    }
    onOpenChange(isOpen);
  }, [onOpenChange]);

  const handleCreate = useCallback(() => {
    if (!newBranchName.trim()) {
      return;
    }
    onCreateWorktree(newBranchName.trim(), baseBranch.trim() || undefined);
    setNewBranchName("");
    setBaseBranch("");
  }, [newBranchName, baseBranch, onCreateWorktree]);

  // Branch Name入力: スペース→ハイフン変換 + エンターで作成
  const handleBranchNameKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === " ") {
        e.preventDefault();
        const input = e.currentTarget;
        const pos = input.selectionStart ?? newBranchName.length;
        const next = newBranchName.slice(0, pos) + "-" + newBranchName.slice(pos);
        setNewBranchName(next);
        // カーソル位置を復元するため、次のレンダー後にselectionを設定
        requestAnimationFrame(() => {
          input.setSelectionRange(pos + 1, pos + 1);
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleCreate();
      }
    },
    [newBranchName, handleCreate],
  );

  // Base Branch入力: エンターで作成
  const handleBaseBranchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreate();
      }
    },
    [handleCreate],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 md:h-7 md:w-7"
          disabled={!selectedRepoPath}
        >
          <Plus className="w-5 h-5 md:w-4 md:h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
        <DialogHeader>
          <DialogTitle>Create New Worktree</DialogTitle>
          <DialogDescription>
            Create a new git worktree with a new branch.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="branch">Branch Name</Label>
            <Input
              id="branch"
              placeholder="feature/new-feature"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={handleBranchNameKeyDown}
              className="font-mono h-12 md:h-10 text-base md:text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="baseBranch">Base Branch (optional)</Label>
            <Input
              id="baseBranch"
              placeholder="main"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              onKeyDown={handleBaseBranchKeyDown}
              className="font-mono h-12 md:h-10 text-base md:text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">Worktree Path (auto-generated)</Label>
            <div className="p-3 md:p-2 rounded-md bg-muted font-mono text-sm text-muted-foreground">
              {selectedRepoPath}-{newBranchName.replace(/\//g, "-") || "branch-name"}
            </div>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => handleOpenChange(false)} className="h-12 md:h-10">
            Cancel
          </Button>
          <Button onClick={handleCreate} className="glow-green h-12 md:h-10">
            Create Worktree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
