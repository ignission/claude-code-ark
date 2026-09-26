/**
 * ボード提案 (Jev 判定) の設定ダイアログ。
 *
 * 有効/閾値/OpenRouter の API キーをサーバーの設定に保存する。鍵は保存後も
 * 画面には戻さず、「設定済み (末尾 4 文字)」だけを見せる。読み書きは
 * useSocket の `getBoardSuggestConfig` / `setBoardSuggestConfig`
 * (`board-suggest:get` / `board-suggest:set`、どちらも ack 付き) で行い、
 * `/api/settings` は通らない (鍵を全件取得に載せないため)。
 */

import type {
  BoardSuggestConfig,
  BoardSuggestConfigPatch,
  BoardSuggestConfigResult,
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

interface BoardSuggestSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 現在の設定を取得する (鍵は末尾 4 文字だけ返る) */
  onLoad: () => Promise<BoardSuggestConfigResult>;
  /** 変更を保存し、保存後の設定を返す */
  onSave: (patch: BoardSuggestConfigPatch) => Promise<BoardSuggestConfigResult>;
}

const SOURCE_LABEL: Record<
  NonNullable<BoardSuggestConfig["keySource"]>,
  string
> = {
  settings: "この画面で設定",
  env: "環境変数 OPENROUTER_API_KEY",
  file: "~/.config/openrouter/api-key",
};

export function BoardSuggestSettingsDialog({
  open,
  onOpenChange,
  onLoad,
  onSave,
}: BoardSuggestSettingsDialogProps) {
  const [config, setConfig] = useState<BoardSuggestConfig | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState("0.7");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const applyConfig = useCallback((next: BoardSuggestConfig) => {
    setConfig(next);
    setEnabled(next.enabled);
    setThreshold(String(next.threshold));
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

  const save = (patch: BoardSuggestConfigPatch) => {
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
    const parsed = Number(threshold);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      setError("閾値は 0〜1 の数値です");
      return;
    }
    const patch: BoardSuggestConfigPatch = { enabled, threshold: parsed };
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
          <DialogTitle>ボード提案の設定</DialogTitle>
          <DialogDescription>
            Claude の返答が終わるたびに Jev (TypeSafe の決定モデル) が
            「チャットよりボードのほうが読みやすいか」を判定し、そうなら Ark が
            返答を文書にしてボードに出します。判定には OpenRouter の API
            キーが要ります (1 回 0.002 円ほど)。
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
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="board-suggest-enabled"
              checked={enabled}
              onCheckedChange={value => setEnabled(value === true)}
              disabled={busy}
            />
            <Label htmlFor="board-suggest-enabled">
              ボード提案を有効にする
            </Label>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-suggest-api-key">OpenRouter API キー</Label>
            <Input
              id="board-suggest-api-key"
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-suggest-threshold">
              閾値 (この確率以上でボードに出す)
            </Label>
            <Input
              id="board-suggest-threshold"
              type="number"
              inputMode="decimal"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={e => setThreshold(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              既定 0.7。0.5 付近は「分からない」。うるさければ上げる
            </p>
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
