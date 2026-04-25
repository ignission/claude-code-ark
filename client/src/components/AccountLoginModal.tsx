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
 * - `useTerminalLinkInjection` でターミナル内のURLをクリック可能化
 *   （xterm.jsが折り返し済URLを論理的に1リンクとして認識するので、`claude /login`
 *   が出すOAuth URLが折り返されていてもクリックで新タブで開ける）
 */
import { CircleCheck, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import type { AccountProfile } from "../../../shared/types";

/** 10分のタイムアウト（サーバ側と一致させる） */
const LOGIN_TIMEOUT_SECONDS = 10 * 60;

interface AccountLoginModalProps {
  open: boolean;
  profile: AccountProfile | null;
  /** AccountLoginManager から返るパス（例: "/ttyd-login/<id>/"） */
  ttydUrl: string | null;
  /**
   * サーバ側で tmux capture-pane から抽出した OAuth 認証用 URL。
   * ttyd のターミナル幅で URL が折り返され、tmux コピーモードでは
   * クリップボード連携が効かないため、サーバ側で URL を抽出して
   * クライアントへ送信し、ボタンで直接ブラウザを開けるようにする。
   */
  detectedUrl: string | null;
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
  detectedUrl,
  onCancel,
}: AccountLoginModalProps) {
  // open になった瞬間を起点にカウントダウンを開始する
  const [remaining, setRemaining] = useState<number>(LOGIN_TIMEOUT_SECONDS);
  // useTerminalLinkInjection: iframe内xterm.jsのURLをクリック可能化する
  // iframeKeyはttydUrl変更ごとに再注入させたいので、ttydUrlのハッシュ的な数値を使う
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeKey = useMemo(() => {
    if (!ttydUrl) return 0;
    let h = 0;
    for (let i = 0; i < ttydUrl.length; i++)
      h = (h * 31 + ttydUrl.charCodeAt(i)) | 0;
    return h;
  }, [ttydUrl]);
  useTerminalLinkInjection(iframeRef, iframeKey);

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

        {/* OAuth URL バナー: ターミナル内で折り返されてクリックできない問題への対処 */}
        {detectedUrl && (
          <div className="px-5 py-3 bg-blue-500/5 border-b border-blue-500/20">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-blue-300 mb-1">
                  認証URLを検出しました
                </p>
                {/* URL自体もクリック可能なリンクにする */}
                <a
                  href={detectedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 hover:underline font-mono truncate block"
                  title={detectedUrl}
                >
                  {detectedUrl}
                </a>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    // Clipboard API → fallback (execCommand) の二段構え
                    // navigator.clipboard はsecure context + 親window focus 必須。
                    // モーダル内Radix Dialog のfocus trap や Cloudflare Tunnel 経由
                    // (HTTPS) でも基本動くが、稀に失敗するためfallbackを用意する
                    let ok = false;
                    try {
                      await navigator.clipboard.writeText(detectedUrl);
                      ok = true;
                    } catch {
                      // Fallback: 一時的な textarea を作成してexecCommand
                      try {
                        const ta = document.createElement("textarea");
                        ta.value = detectedUrl;
                        ta.style.position = "fixed";
                        ta.style.opacity = "0";
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        ok = document.execCommand("copy");
                        document.body.removeChild(ta);
                      } catch {
                        ok = false;
                      }
                    }
                    if (ok) toast.success("URLをコピーしました");
                    else toast.error("コピーに失敗しました");
                  }}
                  className="h-7 px-2 text-xs"
                  title="URLをコピー"
                >
                  <Copy className="w-3 h-3" />
                </Button>
                {/* ブラウザで開くボタン: アンカータグでブラウザネイティブの遷移を使う */}
                <a
                  href={detectedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />
                  ブラウザで開く
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Body: ttyd iframe */}
        <div className="bg-black h-80 w-full">
          {iframeSrc ? (
            <iframe
              ref={iframeRef}
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
