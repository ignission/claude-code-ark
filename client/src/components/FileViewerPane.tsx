import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";

interface FileViewerPaneProps {
  filePath: string;
  content: string;
  mimeType: string;
  size: number;
  targetLine?: number | null;
  error?: string;
}

export function FileViewerPane({
  filePath,
  content,
  mimeType,
  size,
  targetLine,
  error,
}: FileViewerPaneProps) {
  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-destructive bg-background p-4">
        <div className="text-center">
          <p className="text-lg font-medium">ファイルを開けません</p>
          <p className="text-sm text-muted-foreground mt-2">{error}</p>
        </div>
      </div>
    );
  }

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground shrink-0">
        <span className="font-medium text-foreground">{fileName}</span>
        <span className="truncate">{filePath}</span>
        <span className="ml-auto">{formatSize(size)}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {mimeType === "text/markdown" ? (
          <MarkdownRenderer content={content} />
        ) : mimeType.startsWith("image/") ? (
          <ImageRenderer
            content={content}
            mimeType={mimeType}
            filePath={filePath}
          />
        ) : content ? (
          <CodeRenderer
            content={content}
            filePath={filePath}
            targetLine={targetLine}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>バイナリファイルのプレビューはできません</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="p-6 prose prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-code:text-primary prose-a:text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ImageRenderer({
  content,
  mimeType,
  filePath,
}: {
  content: string;
  mimeType: string;
  filePath: string;
}) {
  if (mimeType === "image/svg+xml") {
    // SVGは<img>タグでdata URLとして表示し、スクリプト実行をブロック
    const utf8Bytes = new TextEncoder().encode(content);
    const binaryString = Array.from(utf8Bytes, byte =>
      String.fromCharCode(byte)
    ).join("");
    const dataUrl = `data:image/svg+xml;base64,${btoa(binaryString)}`;
    return (
      <div className="p-4 flex items-center justify-center h-full">
        <img
          src={dataUrl}
          alt={filePath.split("/").pop()}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <p>画像ファイル: {filePath.split("/").pop()}</p>
    </div>
  );
}

function CodeRenderer({
  content,
  filePath,
  targetLine,
}: {
  content: string;
  filePath: string;
  targetLine?: number | null;
}) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const lang = getShikiLang(filePath);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(content, { lang, theme: "github-dark" })
      .then(html => {
        if (!cancelled) setHighlightedHtml(html);
      })
      .catch(() => {
        if (!cancelled) setHighlightedHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [content, lang]);

  useEffect(() => {
    if (!targetLine || !containerRef.current || !highlightedHtml) return;
    const lineEl = containerRef.current.querySelector(
      `.line:nth-child(${targetLine})`
    );
    if (lineEl) {
      lineEl.scrollIntoView({ block: "center" });
      (lineEl as HTMLElement).style.backgroundColor = "rgba(59, 130, 246, 0.2)";
    }
    return () => {
      if (lineEl) {
        (lineEl as HTMLElement).style.backgroundColor = "";
      }
    };
  }, [targetLine, highlightedHtml]);

  if (highlightedHtml) {
    // Shiki出力からscriptタグを除去（安全策）
    const sanitized = highlightedHtml.replace(
      /<script[\s\S]*?<\/script>/gi,
      ""
    );
    return (
      <div
        ref={containerRef}
        className="p-0 text-sm [&_pre]:p-4 [&_pre]:m-0 [&_code]:text-sm"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  const lines = content.split("\n");
  return (
    <div ref={containerRef} className="p-0 text-sm font-mono">
      <pre className="p-4 m-0">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`flex ${targetLine === i + 1 ? "bg-blue-500/20" : ""}`}
          >
            <span className="inline-block w-12 text-right pr-4 text-muted-foreground select-none shrink-0">
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function getShikiLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    mdx: "mdx",
    html: "html",
    css: "css",
    scss: "scss",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    sql: "sql",
    graphql: "graphql",
    lua: "lua",
    swift: "swift",
    kt: "kotlin",
    dart: "dart",
    r: "r",
    php: "php",
    vue: "vue",
    svelte: "svelte",
    dockerfile: "dockerfile",
    xml: "xml",
    svg: "xml",
  };
  return map[ext] ?? "text";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
