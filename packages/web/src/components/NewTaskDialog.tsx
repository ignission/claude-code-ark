/**
 * 新しいタスクのダイアログ。名前とプロンプトだけで、worktree の作成 → セッションの起動 →
 * 最初の文の送信をサーバーの task:start に1回で頼む (実装は server の task-start.ts)。
 *
 * 開く入口は3つ。
 * - サイドバー・モバイルの一覧の見出しの「新しいタスク」: 親なし。リポジトリはここで選び、
 *   ベースは空 (サーバーがリポジトリの既定のブランチを使う)
 * - セッション一覧の行メニューの「子タスクを分離」: その worktree が親、ベースは今のブランチ
 * - 分岐TODOの「新しいworktreeで始める」: 元の worktree が親
 * 親があるときはリポジトリも開いた側で決まっているので、リポジトリの選択は出さない。
 */

import type { TaskStartRequest, TaskStartResponse } from "@ark/shared";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getBaseName } from "@/utils/pathUtils";

/** 開くたびに入れる初期値。parentWorktreePath と todoId はそのまま task:start に渡す */
export interface NewTaskInitial {
  /** null は未選択 (見出しのボタンから開いたとき)。repoList の先頭を入れる */
  repoPath: string | null;
  name?: string;
  prompt?: string;
  baseBranch?: string;
  parentWorktreePath?: string;
  todoId?: string;
}

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** リポジトリの候補 (サイドバーに出しているもの)。親なしで開いたときに選ばせる */
  repoList: readonly string[];
  initial: NewTaskInitial;
  onStartTask: (request: TaskStartRequest) => Promise<TaskStartResponse>;
  /** 起動できたとき (ダイアログは閉じたあと) */
  onStarted: (response: Extract<TaskStartResponse, { ok: true }>) => void;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  repoList,
  initial,
  onStartTask,
  onStarted,
}: NewTaskDialogProps) {
  const [repoPath, setRepoPath] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // open が true になるたびに、そのときの初期値で入れ直す。開いている間に props が変わっても
  // 入力中の値は消さないので、初期値は ref 越しに読む
  const initialRef = useRef({ initial, repoList });
  initialRef.current = { initial, repoList };
  useEffect(() => {
    if (!open) return;
    const { initial: init, repoList: repos } = initialRef.current;
    setRepoPath(init.repoPath ?? repos[0] ?? "");
    setName(init.name ?? "");
    setPrompt(init.prompt ?? "");
    setBaseBranch(init.baseBranch ?? "");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const canSubmit =
    !submitting &&
    repoPath !== "" &&
    name.trim() !== "" &&
    prompt.trim() !== "";

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const { initial: init } = initialRef.current;
    const response = await onStartTask({
      repoPath,
      name: name.trim(),
      prompt: prompt.trim(),
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(init.parentWorktreePath
        ? { parentWorktreePath: init.parentWorktreePath }
        : {}),
      ...(init.todoId ? { todoId: init.todoId } : {}),
    });
    setSubmitting(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    onOpenChange(false);
    onStarted(response);
  }, [
    canSubmit,
    repoPath,
    name,
    prompt,
    baseBranch,
    onStartTask,
    onOpenChange,
    onStarted,
  ]);

  // タスク名はブランチ名になるので、空白はハイフンにする (作成ダイアログと同じ)
  const handleNameKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== " ") return;
      e.preventDefault();
      const input = e.currentTarget;
      const pos = input.selectionStart ?? name.length;
      setName(`${name.slice(0, pos)}-${name.slice(pos)}`);
      requestAnimationFrame(() => input.setSelectionRange(pos + 1, pos + 1));
    },
    [name]
  );

  // プロンプトは複数行なので Enter は改行。Cmd/Ctrl+Enter で起動する
  const handlePromptKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  const parentPath = initial.parentWorktreePath;
  const repoOptions =
    repoPath && !repoList.includes(repoPath)
      ? [repoPath, ...repoList]
      : repoList;

  return (
    <Dialog
      open={open}
      onOpenChange={next => !submitting && onOpenChange(next)}
    >
      <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-lg mx-auto">
        <DialogHeader>
          <DialogTitle>新しいタスク</DialogTitle>
          <DialogDescription>
            {parentPath
              ? `${getBaseName(parentPath)} から新しいworktreeを分け、セッションを起動してプロンプトを最初の文として送ります。`
              : "新しいworktreeでセッションを起動し、プロンプトを最初の文として送ります。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {!parentPath && repoOptions.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="new-task-repo">リポジトリ</Label>
              <select
                id="new-task-repo"
                value={repoPath}
                onChange={e => setRepoPath(e.target.value)}
                className="h-12 md:h-10 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm"
              >
                {repoOptions.map(repo => (
                  <option key={repo} value={repo}>
                    {getBaseName(repo)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="new-task-name">タスク名</Label>
            <Input
              id="new-task-name"
              placeholder="fix-log-format"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 md:h-10 text-base md:text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-task-prompt">プロンプト</Label>
            <Textarea
              id="new-task-prompt"
              placeholder="最初に送る文"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              rows={5}
              className="text-base md:text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-task-base">ベースブランチ (省略可)</Label>
            <Input
              id="new-task-base"
              placeholder={
                parentPath ? "親の今のブランチ" : "リポジトリの既定のブランチ"
              }
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 md:h-10 text-base md:text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-12 md:h-10"
          >
            キャンセル
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="h-12 md:h-10"
          >
            {submitting ? "起動中..." : "起動する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
