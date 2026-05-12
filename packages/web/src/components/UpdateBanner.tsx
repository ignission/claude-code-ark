/**
 * F8: 新版検出バナー
 *
 * Electron main プロセスから `ark:update-available` IPC を受け取って表示する
 * ソフト通知。Electron 経由でない場合 (ブラウザ版、`window.electronAPI` 不在)
 * は何もレンダリングしない。
 *
 * 操作:
 *  - `brew upgrade --cask ark` をクリップボードにコピー
 *  - GitHub Release ページを開く (Electron 経由なら external browser)
 *  - 閉じる (セッション内で再表示しない。次回起動時に新版があれば再通知)
 */

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface UpdateInfo {
  latestVersion: string;
  htmlUrl: string;
  publishedAt: string;
}

declare global {
  interface Window {
    electronAPI?: {
      onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
    };
  }
}

const BREW_UPGRADE_COMMAND = "brew upgrade --cask ark";

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // ブラウザ版では electronAPI が undefined。何も購読しない。
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.onUpdateAvailable(newInfo => {
      setInfo(newInfo);
      setDismissed(false);
    });
    return unsubscribe;
  }, []);

  if (!info || dismissed) return null;

  const handleCopy = () => {
    void navigator.clipboard.writeText(BREW_UPGRADE_COMMAND);
  };

  const handleOpenChangelog = () => {
    window.open(info.htmlUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <Alert className="m-2 border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950">
      <AlertTitle>新しいバージョンが利用可能です</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3 mt-1">
        <span>Ark {info.latestVersion}</span>
        <code className="bg-muted px-2 py-1 rounded text-xs">
          {BREW_UPGRADE_COMMAND}
        </code>
        <Button size="sm" variant="outline" onClick={handleCopy}>
          コピー
        </Button>
        <Button size="sm" variant="ghost" onClick={handleOpenChangelog}>
          変更点
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          ×
        </Button>
      </AlertDescription>
    </Alert>
  );
}
