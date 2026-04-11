interface HtmlViewerPaneProps {
  filePath: string;
}

function getUrlToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

/**
 * 絶対パスのHTMLファイルをiframeで表示するコンポーネント。
 * 注意: HTMLファイルと同ディレクトリの相対リソース（CSS/JS/画像）は
 * ブラウザのセキュリティ制約により正しく読み込まれない場合がある。
 * self-contained（全リソースインライン）なHTMLファイルを対象とする。
 */
export function HtmlViewerPane({ filePath }: HtmlViewerPaneProps) {
  const token = getUrlToken();
  let src = `/api/html-file?path=${encodeURIComponent(filePath)}`;
  if (token) {
    src += `&token=${encodeURIComponent(token)}`;
  }

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      sandbox="allow-scripts"
      title={filePath.split("/").pop() || "HTML"}
    />
  );
}
