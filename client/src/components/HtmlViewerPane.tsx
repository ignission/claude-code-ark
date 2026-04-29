import { Camera, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface HtmlViewerPaneProps {
  filePath: string;
}

/**
 * 絶対パスのHTMLファイルをiframeで表示するコンポーネント。
 * fetch→srcdoc方式でHTMLを表示し、認証トークンがiframe内に露出しない。
 * self-contained（全リソースインライン）なHTMLファイルを対象とする。
 *
 * ツールバーの「画像保存」から PR 用の PNG スクリーンショットを取得できる。
 */
export function HtmlViewerPane({ filePath }: HtmlViewerPaneProps) {
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    // filePath変更時にステート状態をリセット（古いコンテンツ/エラーの残留を防止）
    setHtmlContent(null);
    setError(null);

    const controller = new AbortController();
    fetch(buildScreenshotUrl(filePath, { mode: "html" }), {
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(html => {
        // 中断済みの場合はステート更新をスキップ
        if (!controller.signal.aborted) {
          setHtmlContent(html);
        }
      })
      .catch(e => {
        // AbortErrorは正常なキャンセルなので無視
        if (e.name !== "AbortError") {
          setError(e.message);
        }
      });

    return () => controller.abort();
  }, [filePath]);

  const filename = filePath.split("/").pop() || "html";

  async function handleCopyImage() {
    setExporting(true);
    try {
      const res = await fetch(
        buildScreenshotUrl(filePath, { mode: "screenshot" })
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      toast.success("画像をクリップボードにコピーしました");
    } catch (e) {
      toast.error(
        `画像のコピーに失敗しました: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleDownloadImage() {
    setExporting(true);
    try {
      const res = await fetch(
        buildScreenshotUrl(filePath, { mode: "screenshot" })
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename.replace(/\.html?$/i, "")}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(
        `画像のダウンロードに失敗しました: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={exporting || htmlContent === null}
            >
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Camera className="w-3.5 h-3.5" />
              )}
              画像保存
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={handleCopyImage}>
              <Camera className="w-4 h-4 mr-2" />
              クリップボードにコピー
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleDownloadImage}>
              <Download className="w-4 h-4 mr-2" />
              PNG をダウンロード
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 min-h-0">
        {error ? (
          <div className="flex items-center justify-center h-full text-destructive">
            <p>HTMLファイルの読み込みに失敗しました: {error}</p>
          </div>
        ) : htmlContent === null ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>読み込み中...</p>
          </div>
        ) : (
          <iframe
            srcDoc={htmlContent}
            className="w-full h-full border-0"
            sandbox="allow-scripts"
            title={filename}
          />
        )}
      </div>
    </div>
  );
}

/**
 * /api/html-file 系エンドポイントの URL を構築する。
 * リモートアクセス時は token クエリパラメータを継承する。
 */
function buildScreenshotUrl(
  filePath: string,
  opts: { mode: "html" | "screenshot" }
): string {
  const token = new URLSearchParams(window.location.search).get("token");
  const base =
    opts.mode === "html" ? "/api/html-file" : "/api/html-file/screenshot";
  let url = `${base}?path=${encodeURIComponent(filePath)}`;
  if (token) {
    url += `&token=${encodeURIComponent(token)}`;
  }
  return url;
}
