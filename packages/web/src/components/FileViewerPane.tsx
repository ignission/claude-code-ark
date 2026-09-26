import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import {
  HIGHLIGHT_LINE_CLASS,
  HIGHLIGHT_LINE_STYLE,
  isHighlightedLine,
} from "@/lib/file-viewer-highlight";

interface FileViewerPaneProps {
  filePath: string;
  content: string;
  mimeType: string;
  size: number;
  targetLine?: number | null;
  targetEndLine?: number | null;
  error?: string;
}

export function FileViewerPane({
  filePath,
  content,
  mimeType,
  size,
  targetLine,
  targetEndLine,
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
            targetEndLine={targetEndLine}
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
    <div className="p-6 prose dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-code:text-primary prose-a:text-primary">
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
  // SVGはテキストコンテンツからdata URLを生成
  if (mimeType === "image/svg+xml") {
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

  // PNG/JPG/GIF/WebP等はサーバーからdata URLとして受信済み
  if (content) {
    return (
      <div className="p-4 flex items-center justify-center h-full">
        <img
          src={content}
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
  targetEndLine,
}: {
  content: string;
  filePath: string;
  targetLine?: number | null;
  targetEndLine?: number | null;
}) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const lang = getShikiLang(filePath);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(content, {
      lang,
      theme: "github-dark",
      // ハイライトは出力へ焼き込む。DOM を後から書き換えると再描画で消える (#481)
      transformers: [
        {
          line(node, line) {
            if (!isHighlightedLine(line, targetLine, targetEndLine)) return;
            const current =
              typeof node.properties.class === "string"
                ? `${node.properties.class} `
                : "";
            node.properties.class = `${current}${HIGHLIGHT_LINE_CLASS}`;
            node.properties.style = HIGHLIGHT_LINE_STYLE;
          },
        },
      ],
    })
      .then(html => {
        if (!cancelled) setHighlightedHtml(html);
      })
      .catch(() => {
        if (!cancelled) setHighlightedHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [content, lang, targetLine, targetEndLine]);

  // 見た目は shiki の出力が持つので、ここは目的の行へ寄せるだけ
  useEffect(() => {
    if (!targetLine || !containerRef.current || !highlightedHtml) return;
    containerRef.current
      .querySelector(`.${HIGHLIGHT_LINE_CLASS}`)
      ?.scrollIntoView({ block: "center" });
  }, [targetLine, highlightedHtml]);

  if (highlightedHtml) {
    // Shiki出力からscriptタグを除去（安全策）
    const sanitized = highlightedHtml.replace(
      /<script[\s\S]*?<\/script>/gi,
      ""
    );
    const lineCount = content.split("\n").length;
    return (
      <div ref={containerRef} className="flex text-sm">
        <div
          className="shrink-0 select-none text-muted-foreground text-right pr-4 py-4 pl-2 leading-5"
          style={{ minWidth: "3rem" }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={`line-${i}`}
              className={
                isHighlightedLine(i + 1, targetLine, targetEndLine)
                  ? "bg-primary/25 text-foreground"
                  : ""
              }
            >
              {i + 1}
            </div>
          ))}
        </div>
        <div
          // 行全体に背景を敷くため code を grid にする (span のままだと行末までしか
          // 色が伸びない)。ただし grid では中身の無い .line が高さ 0 に潰れるので、
          // min-h で 1 行分を確保しないと空行の数だけ左の行番号とずれる
          className="flex-1 [&_pre]:p-4 [&_pre]:m-0 [&_pre]:leading-5 [&_code]:text-sm [&_code]:grid [&_code]:leading-5 [&_.line]:leading-5 [&_.line]:min-h-5 overflow-x-auto"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki出力はscriptタグ除去済み
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      </div>
    );
  }

  const lines = content.split("\n");
  return (
    <div ref={containerRef} className="p-0 text-sm font-mono">
      <pre className="p-4 m-0">
        {lines.map((line, i) => (
          <div
            key={`line-${i}`}
            className={`flex ${
              isHighlightedLine(i + 1, targetLine, targetEndLine)
                ? "bg-primary/25"
                : ""
            }`}
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
