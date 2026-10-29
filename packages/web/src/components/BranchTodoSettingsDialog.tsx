/**
 * 分岐TODO (Jev 判定) の設定ダイアログ。
 *
 * 有効/閾値/OpenRouter の API キーをサーバーの設定に保存する。鍵は保存後も
 * 画面には戻さず、「設定済み (末尾 4 文字)」だけを見せる。読み書きは
 * useSocket の `getBranchTodoConfig` / `setBranchTodoConfig`
 * (`branch-todo:get` / `branch-todo:set`、どちらも ack 付き) で行い、
 * `/api/settings` は通らない (鍵を全件取得に載せないため)。
 */

import type {
  BranchTodoConfig,
  BranchTodoConfigPatch,
  BranchTodoConfigResult,
} from "@ark/shared";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BranchTodoSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 現在の設定を取得する (鍵は末尾 4 文字だけ返る) */
  onLoad: () => Promise<BranchTodoConfigResult>;
  /** 変更を保存し、保存後の設定を返す */
  onSave: (patch: BranchTodoConfigPatch) => Promise<BranchTodoConfigResult>;
}

const SOURCE_LABEL: Record<
  NonNullable<BranchTodoConfig["keySource"]>,
  string
> = {
  settings: "この画面で設定",
  env: "環境変数 OPENROUTER_API_KEY",
  file: "~/.config/openrouter/api-key",
};

export function BranchTodoSettingsDialog({
  open,
  onOpenChange,
  onLoad,
  onSave,
}: BranchTodoSettingsDialogProps) {
  const [config, setConfig] = useState<BranchTodoConfig | null>(null);
  const [todoEnabled, setTodoEnabled] = useState(true);
  const [todoThreshold, setTodoThreshold] = useState("0.7");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const applyConfig = useCallback((next: BranchTodoConfig) => {
    setConfig(next);
    setTodoEnabled(next.todoEnabled);
    setTodoThreshold(String(next.todoThreshold));
    setApiKey("");
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setSaved(false);
    setBusy(true);
    onLoad().then(result => {
      if (cancelled) return;
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      applyConfig(result.config);
    });
    return () => {
      cancelled = true;
    };
  }, [open, onLoad, applyConfig]);

  const save = (patch: BranchTodoConfigPatch) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    onSave(patch).then(result => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      applyConfig(result.config);
      setSaved(true);
    });
  };

  const submit = () => {
    const parsedTodo = Number(todoThreshold);
    if (!Number.isFinite(parsedTodo) || parsedTodo < 0 || parsedTodo > 1) {
      setError("閾値は 0〜1 の数値です");
      return;
    }
    const patch: BranchTodoConfigPatch = {
      todoEnabled,
      todoThreshold: parsedTodo,
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    save(patch);
  };

  const keyPlaceholder = config?.keyConfigured
    ? `設定済み (末尾 ${config.keyHint})。変えるときだけ入力`
    : "sk-or-v1-…";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>分岐TODOの設定</DialogTitle>
          <DialogDescription>
            Claude の返答が終わるたびに Jev (TypeSafe の決定モデル)
            が「保留にした話題があるか」を判定し、あれば Claude に TODO
            へ足させます。判定には OpenRouter の API キーが要ります (1 回 0.002
            円ほど)。
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          // ブラウザの検証 (max=1 等) で黙って止めず、自前の理由を出す
          noValidate
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-todo-api-key">OpenRouter API キー</Label>
            <Input
              id="branch-todo-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={keyPlaceholder}
              onChange={e => setApiKey(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {config?.keyConfigured && config.keySource
                ? `いまの鍵の出どころ: ${SOURCE_LABEL[config.keySource]}`
                : "鍵が無い間は判定しません。https://openrouter.ai/settings/keys で発行できます"}
            </p>
          </div>

          <div className="flex flex-col gap-1.5 border-t pt-4">
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id="branch-todo-enabled"
                checked={todoEnabled}
                onCheckedChange={value => setTodoEnabled(value === true)}
                disabled={busy}
              />
              <Label htmlFor="branch-todo-enabled">
                分岐TODOの検出を有効にする
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              既定 0.7。0.5 付近は「分からない」。うるさければ上げる
            </p>
            <Label htmlFor="branch-todo-threshold">
              閾値 (この確率以上でTODOに足させる)
            </Label>
            <Input
              id="branch-todo-threshold"
              type="number"
              inputMode="decimal"
              min={0}
              max={1}
              step={0.05}
              value={todoThreshold}
              onChange={e => setTodoThreshold(e.target.value)}
              disabled={busy}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="text-sm text-muted-foreground" role="status">
              保存しました。次の返答から効きます
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {config?.keySource === "settings" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => save({ apiKey: null })}
                disabled={busy}
              >
                鍵を削除
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              保存
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
