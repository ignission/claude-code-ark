interface HtmlViewerPaneProps {
  filePath: string;
}

export function HtmlViewerPane({ filePath }: HtmlViewerPaneProps) {
  const src = `/api/html-file?path=${encodeURIComponent(filePath)}`;

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-same-origin"
      title={filePath.split("/").pop() || "HTML"}
    />
  );
}
