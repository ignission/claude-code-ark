/**
 * AccountLoginModal - 複数アカウント機能のログイン用モーダル (Linux限定)
 *
 * Design: モックHTML シナリオ3（ログインモーダル） + シナリオ4（ログイン完了）
 * - ttyd iframe で `claude /login` を埋め込み表示
 * - 残り時間カウントダウン (10分)
 * - キャンセルボタン (onCancel)
 * - 認証完了は親（Dashboard / useSocket）が `account:login-completed` を受けて
 *   `open=false` にすることで自動的に閉じる
 *
 * iframe方針:
 * - `sandbox` 属性は **付けない**（既存 TerminalPane と同じ。CSP/X-Frame-Options
 *   サーバ側で SAMEORIGIN 設定済み）
 * - URL構築は TerminalPane と同じ。Quick Tunnel 利用時は token クエリを引き継ぐ
 */
import { CircleCheck, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccountProfile } from "../../../shared/types";

/** 10分のタイムアウト（サーバ側と一致させる） */
const LOGIN_TIMEOUT_SECONDS = 10 * 60;

interface AccountLoginModalProps {
  open: boolean;
  profile: AccountProfile | null;
  /** AccountLoginManager から返るパス（例: "/ttyd-login/<id>/"） */
  ttydUrl: string | null;
  onCancel: () => void;
}

/** 残り秒数を MM:SS にゼロ埋めフォーマット */
function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const ss = (safe % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function AccountLoginModal({
  open,
  profile,
  ttydUrl,
  onCancel,
}: AccountLoginModalProps) {
  // open になった瞬間を起点にカウントダウンを開始する
  const [remaining, setRemaining] = useState<number>(LOGIN_TIMEOUT_SECONDS);

  useEffect(() => {
    if (!open) {
      // 閉じている間は満タンにリセット（次回openで再カウント）
      setRemaining(LOGIN_TIMEOUT_SECONDS);
      return;
    }
    // open 開始時刻を記録し、setIntervalで残り秒数を更新する
    const startedAt = Date.now();
    setRemaining(LOGIN_TIMEOUT_SECONDS);
    const intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const next = LOGIN_TIMEOUT_SECONDS - elapsed;
      // 0 で固定（サーバ側のタイムアウトでfailedが届くまで待つ）
      setRemaining(next > 0 ? next : 0);
    }, 1000);
    return () => {
      clearInterval(intervalId);
    };
  }, [open]);

  // ttyd iframe URL を構築
  // - ローカル: window.location.origin + ttydUrl
  // - Quick Tunnel: 現在のURLに ?token=... が付いている場合はそれを引き継ぐ
  const iframeSrc = useMemo(() => {
    if (!ttydUrl) return "";
    if (typeof window === "undefined") return ttydUrl;
    const urlToken = new URLSearchParams(window.location.search).get("token");
    return urlToken ? `${ttydUrl}?token=${urlToken}` : ttydUrl;
  }, [ttydUrl]);

  // 必須プロパティが揃っていない場合はクローズ状態のDialogだけ返す
  // (Radix Dialog の状態管理を維持するため null を返さない)
  const isReady = open && profile !== null && ttydUrl !== null;

  return (
    <Dialog
      open={isReady}
      onOpenChange={nextOpen => {
        // ユーザーがオーバーレイクリックやEscapeで閉じようとした場合もキャンセル扱い
        if (!nextOpen && isReady) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-3xl p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <DialogHeader className="px-5 py-4 border-b border-border flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
            <DialogTitle className="font-semibold tracking-tight text-base">
              アカウント
              <span className="text-blue-300 mx-1">
                「{profile?.name ?? ""}」
              </span>
              のログイン
            </DialogTitle>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            残り {formatRemaining(remaining)}
          </span>
        </DialogHeader>

        {/* Body: ttyd iframe */}
        <div className="bg-black h-80 w-full">
          {iframeSrc ? (
            <iframe
              src={iframeSrc}
              className="w-full h-full border-0"
              title={`Login terminal - ${profile?.name ?? ""}`}
              allow="clipboard-read; clipboard-write; keyboard-map"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ターミナル起動中...
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/30 flex items-center justify-between">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CircleCheck className="w-3.5 h-3.5" />
            ログイン完了で自動的にこのウィンドウは閉じます
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onCancel}
            className="text-sm"
          >
            キャンセル
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AccountLoginModal;
