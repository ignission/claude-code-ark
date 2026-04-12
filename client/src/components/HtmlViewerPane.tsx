import { useEffect, useState } from "react";

interface HtmlViewerPaneProps {
  filePath: string;
}

/**
 * 絶対パスのHTMLファイルをiframeで表示するコンポーネント。
 * fetch→srcdoc方式でHTMLを表示し、認証トークンがiframe内に露出しない。
 * self-contained（全リソースインライン）なHTMLファイルを対象とする。
 */
export function HtmlViewerPane({ filePath }: HtmlViewerPaneProps) {
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // filePath変更時にステート状態をリセット（古いコンテンツ/エラーの残留を防止）
    setHtmlContent(null);
    setError(null);

    const controller = new AbortController();
    const token = new URLSearchParams(window.location.search).get("token");
    let url = `/api/html-file?path=${encodeURIComponent(filePath)}`;
    if (token) {
      url += `&token=${encodeURIComponent(token)}`;
    }

    fetch(url, { signal: controller.signal })
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

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        <p>HTMLファイルの読み込みに失敗しました: {error}</p>
      </div>
    );
  }

  if (htmlContent === null) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>読み込み中...</p>
      </div>
    );
  }

  return (
    <iframe
      srcDoc={htmlContent}
      className="w-full h-full border-0"
      sandbox="allow-scripts"
      title={filePath.split("/").pop() || "HTML"}
    />
  );
}
