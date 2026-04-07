# ファイルビューワー & ローカルポートブラウザ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claudeのターミナル出力に含まれるファイルパスやlocalhost URLを自動検出し、クリッカブルリンクとしてファイルビューワー/ローカルポートブラウザをタブで開く機能を追加する。

**Architecture:** ttyd iframe内のxterm.jsにJSインジェクトしてリンク検出 → postMessageで親ウィンドウに通知 → React側でタブ管理 → ファイルはサーバーのファイルAPI経由で取得しShiki/react-markdownでレンダリング、localhost URLはiframeで表示。

**Tech Stack:** Shiki（シンタックスハイライト）、react-markdown + remark-gfm（Markdownレンダリング）、Socket.IO（ファイルAPI）、xterm.js registerLinkProvider（リンク検出）

**Spec:** `docs/superpowers/specs/2026-04-07-file-viewer-browser-design.md`

---

## ファイル構成

| ファイル | 責務 |
|---------|------|
| `shared/types.ts` | file:read / file:content イベント型追加 |
| `server/lib/file-manager.ts` | **新規** worktree内ファイルの安全な読み取り |
| `server/index.ts` | file:readハンドラー登録 |
| `client/src/hooks/useSocket.ts` | file:contentイベントハンドリング、readFileメソッド |
| `client/src/components/FileViewerPane.tsx` | **新規** ファイル内容のレンダリング |
| `client/src/components/BrowserPane.tsx` | **新規** localhost URLのiframe表示 |
| `client/src/components/TerminalPane.tsx` | タブバー追加、postMessageリスナー、リンクインジェクト |
| `client/src/components/MobileSessionView.tsx` | モバイル版タブバー+ビューワー対応 |
| `client/src/pages/Dashboard.tsx` | タブ状態管理、TerminalPaneへのprops追加 |

---

### Task 1: 依存ライブラリの追加

**Files:**
- Modify: `package.json`

- [ ] **Step 1: shiki, react-markdown, remark-gfm をインストール**

```bash
pnpm add shiki react-markdown remark-gfm
```

- [ ] **Step 2: インストール確認**

Run: `pnpm ls shiki react-markdown remark-gfm`
Expected: 3パッケージがリストに表示される

- [ ] **Step 3: コミット**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: shiki, react-markdown, remark-gfmを追加"
```

---

### Task 2: 型定義の追加（shared/types.ts）

**Files:**
- Modify: `shared/types.ts:96-218`

- [ ] **Step 1: FileContentデータ型とSocket.IOイベント型を追加**

`shared/types.ts` の `ServerToClientEvents` インターフェース内、`"beacon:error"` イベント（現在最後のBeaconイベント）の直後に以下を追加:

```typescript
  // ファイルビューワー
  "file:content": (data: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  }) => void;
```

`ClientToServerEvents` インターフェース内、`"beacon:close"` イベント（現在最後のBeaconイベント）の直後に以下を追加:

```typescript
  // ファイルビューワー
  "file:read": (data: { sessionId: string; filePath: string }) => void;
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add shared/types.ts
git commit -m "types: file:read / file:content イベント型を追加"
```

---

### Task 3: サーバー側ファイルマネージャー（server/lib/file-manager.ts）

**Files:**
- Create: `server/lib/file-manager.ts`

- [ ] **Step 1: file-manager.tsを作成**

```typescript
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// 拡張子→MIMEタイプのマッピング
const EXTENSION_MIME_MAP: Record<string, string> = {
  // Markdown
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  // JavaScript/TypeScript
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  // データ
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  // Web
  ".html": "text/html",
  ".css": "text/css",
  ".scss": "text/css",
  // シェル
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  // 設定
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  // ドキュメント
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  // 画像
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // その他コード
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".proto": "text/x-protobuf",
  ".lua": "text/x-lua",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".dart": "text/x-dart",
  ".r": "text/x-r",
  ".php": "text/x-php",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
};

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "image/svg+xml"
  );
}

/**
 * worktreePath内のファイルパスを安全に解決する。
 * パストラバーサルを防止し、worktreeルート外へのアクセスを拒否する。
 */
async function resolveSafePath(
  worktreePath: string,
  filePath: string
): Promise<string> {
  // 絶対パスの拒否
  if (path.isAbsolute(filePath)) {
    throw new Error(`絶対パスは指定できません: ${filePath}`);
  }

  // 親ディレクトリ参照の拒否
  if (filePath.includes("..")) {
    throw new Error(`不正なパスです: ${filePath}`);
  }

  const resolvedWorktree = await realpath(worktreePath);
  const resolved = path.resolve(resolvedWorktree, filePath);

  // シンボリックリンク解決後にも検証
  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    // ファイルが存在しない場合は解決前のパスで検証
    realResolved = resolved;
  }

  if (!realResolved.startsWith(resolvedWorktree + path.sep) && realResolved !== resolvedWorktree) {
    throw new Error(`worktreeルート外へのアクセスは拒否されました: ${filePath}`);
  }

  return realResolved;
}

export interface FileReadResult {
  filePath: string;
  content: string;
  mimeType: string;
  size: number;
}

/**
 * worktree内のファイルを安全に読み取る。
 */
export async function readFileFromWorktree(
  worktreePath: string,
  filePath: string
): Promise<FileReadResult> {
  const safePath = await resolveSafePath(worktreePath, filePath);
  const fileStat = await stat(safePath);

  if (!fileStat.isFile()) {
    throw new Error(`ファイルではありません: ${filePath}`);
  }

  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(
      `ファイルサイズが上限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています: ${fileStat.size} bytes`
    );
  }

  const mimeType = detectMimeType(filePath);

  // バイナリファイルはcontentを返さない
  if (!isTextMimeType(mimeType)) {
    return {
      filePath,
      content: "",
      mimeType,
      size: fileStat.size,
    };
  }

  const content = await readFile(safePath, "utf-8");
  return {
    filePath,
    content,
    mimeType,
    size: fileStat.size,
  };
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add server/lib/file-manager.ts
git commit -m "feat: サーバー側ファイルマネージャーを追加"
```

---

### Task 4: サーバー側ハンドラー登録（server/index.ts）

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: file-managerのimportを追加**

`server/index.ts` の既存importブロック（先頭付近）に以下を追加:

```typescript
import { readFileFromWorktree } from "./lib/file-manager.js";
```

- [ ] **Step 2: file:readハンドラーを追加**

`server/index.ts` の `socket.on("image:upload", ...)` ハンドラー（行884-902付近）の直後、`socket.on("beacon:send", ...)` の直前に以下を追加:

```typescript
    // ===== File Viewer =====
    socket.on("file:read", async ({ sessionId, filePath }) => {
      try {
        const session = orchestrator.getSession(sessionId);
        if (!session) throw new Error(`セッションが見つかりません: ${sessionId}`);
        const result = await readFileFromWorktree(session.worktreePath, filePath);
        socket.emit("file:content", result);
      } catch (error) {
        socket.emit("file:content", {
          filePath,
          content: "",
          mimeType: "application/octet-stream",
          size: 0,
          error: getErrorMessage(error),
        });
      }
    });
```

- [ ] **Step 3: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add server/index.ts
git commit -m "feat: file:readハンドラーをSocket.IOに追加"
```

---

### Task 5: クライアント側Socket.IOフック（useSocket.ts）

**Files:**
- Modify: `client/src/hooks/useSocket.ts`

- [ ] **Step 1: fileContent stateを追加**

`useSocket.ts` の state定義セクション（行156-160付近、`imageUploadResult`/`imageUploadError` の付近）に以下を追加:

```typescript
  const [fileContent, setFileContent] = useState<{
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null>(null);
```

- [ ] **Step 2: file:contentイベントハンドラーを追加**

`useSocket.ts` の `socket.on("image:error", ...)` ハンドラー（行410-416付近）の直後、Beaconイベントの前に以下を追加:

```typescript
      // File viewer events
      socket.on("file:content", (data) => {
        console.log("[Socket] File content received:", data.filePath);
        setFileContent(data);
      });
```

- [ ] **Step 3: readFileメソッドを追加**

`useSocket.ts` のSocket送信メソッドセクション（`uploadImage` メソッド付近、行587-598付近）の後に以下を追加:

```typescript
  const readFile = useCallback(
    (sessionId: string, filePath: string) => {
      if (!socketRef.current?.connected) return;
      socketRef.current.emit("file:read", { sessionId, filePath });
    },
    []
  );
```

- [ ] **Step 4: return値にfileContent, readFileを追加**

`useSocket.ts` の戻り値オブジェクト（行657-709付近）に以下を追加:

```typescript
    fileContent,
    readFile,
```

- [ ] **Step 5: cleanupでfile:contentリスナーを解除**

`useSocket.ts` の cleanup関数（`socket.off(...)` が列挙されている箇所）に以下を追加:

```typescript
        socket.off("file:content");
```

- [ ] **Step 6: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add client/src/hooks/useSocket.ts
git commit -m "feat: useSocketにfile:content/readFileを追加"
```

---

### Task 6: ファイルビューワーコンポーネント（FileViewerPane.tsx）

**Files:**
- Create: `client/src/components/FileViewerPane.tsx`

- [ ] **Step 1: FileViewerPane.tsxを作成**

```tsx
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
      {/* ヘッダー */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground shrink-0">
        <span className="font-medium text-foreground">{fileName}</span>
        <span className="truncate">{filePath}</span>
        <span className="ml-auto">{formatSize(size)}</span>
      </div>

      {/* コンテンツ */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mimeType === "text/markdown" ? (
          <MarkdownRenderer content={content} />
        ) : mimeType.startsWith("image/") ? (
          <ImageRenderer content={content} mimeType={mimeType} filePath={filePath} />
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
  // SVGはインラインで表示
  if (mimeType === "image/svg+xml") {
    return (
      <div
        className="p-4 flex items-center justify-center h-full"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    );
  }

  // その他の画像（サーバーから取得不可のためメッセージ表示）
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
    codeToHtml(content, {
      lang,
      theme: "github-dark",
    })
      .then((html) => {
        if (!cancelled) setHighlightedHtml(html);
      })
      .catch(() => {
        // フォールバック: プレーンテキスト表示
        if (!cancelled) setHighlightedHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [content, lang]);

  // 指定行へスクロール
  useEffect(() => {
    if (!targetLine || !containerRef.current || !highlightedHtml) return;
    const lineEl = containerRef.current.querySelector(
      `.line:nth-child(${targetLine})`
    );
    if (lineEl) {
      lineEl.scrollIntoView({ block: "center" });
      (lineEl as HTMLElement).style.backgroundColor = "rgba(59, 130, 246, 0.2)";
    }
  }, [targetLine, highlightedHtml]);

  if (highlightedHtml) {
    return (
      <div
        ref={containerRef}
        className="p-0 text-sm [&_pre]:p-4 [&_pre]:m-0 [&_code]:text-sm"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  // フォールバック: プレーンテキスト + 行番号
  const lines = content.split("\n");
  return (
    <div ref={containerRef} className="p-0 text-sm font-mono">
      <pre className="p-4 m-0">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`flex ${
              targetLine === i + 1 ? "bg-blue-500/20" : ""
            }`}
          >
            <span className="inline-block w-12 text-right pr-4 text-muted-foreground select-none shrink-0">
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-all">
              {line}
            </span>
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
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/components/FileViewerPane.tsx
git commit -m "feat: ファイルビューワーコンポーネントを追加"
```

---

### Task 7: ローカルポートブラウザコンポーネント（BrowserPane.tsx）

**Files:**
- Create: `client/src/components/BrowserPane.tsx`

- [ ] **Step 1: BrowserPane.tsxを作成**

```tsx
import { useCallback, useRef, useState } from "react";
import { Button } from "./ui/button";
import { RotateCw, ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";

interface BrowserPaneProps {
  url: string;
}

function resolveUrl(url: string): string {
  // ローカルアクセスの場合はそのまま
  if (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  ) {
    return url;
  }

  // リモートアクセスの場合はプロキシ経由
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1"
    ) {
      return `/proxy/${parsed.port || "80"}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // パース失敗時はそのまま返す
  }
  return url;
}

export function BrowserPane({ url }: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const resolvedUrl = resolveUrl(url);

  const handleReload = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank");
  }, [url]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* アドレスバー */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
          title="戻る"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
          title="進む"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleReload}
          title="リロード"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1 bg-muted rounded px-2 py-0.5 text-xs text-muted-foreground truncate mx-1">
          {url}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleOpenExternal}
          title="外部ブラウザで開く"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={resolvedUrl}
          className="w-full h-full border-0"
          title={`Browser - ${url}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/components/BrowserPane.tsx
git commit -m "feat: ローカルポートブラウザコンポーネントを追加"
```

---

### Task 8: TerminalPaneにタブバーとリンクインジェクトを追加

**Files:**
- Modify: `client/src/components/TerminalPane.tsx`

- [ ] **Step 1: タブ型定義とpropsを追加**

`TerminalPane.tsx` の先頭のimportセクションの後、`TerminalPaneProps` interfaceの前に以下のタブ型定義を追加:

```typescript
export type ViewerTab =
  | { type: "terminal" }
  | { type: "file"; filePath: string; content: string; mimeType: string; size: number; targetLine?: number | null; error?: string }
  | { type: "browser"; url: string };
```

`TerminalPaneProps` に以下のpropsを追加:

```typescript
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
```

- [ ] **Step 2: FileViewerPaneとBrowserPaneをimport**

```typescript
import { FileViewerPane } from "./FileViewerPane";
import { BrowserPane } from "./BrowserPane";
```

- [ ] **Step 3: タブバーUIを追加**

`TerminalPane.tsx` の `</header>` の直後、ttyd iframeの `<div>` の直前に、タブバーを追加:

```tsx
      {/* タブバー */}
      {tabs.length > 1 && (
        <div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto shrink-0">
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex;
            const label =
              tab.type === "terminal"
                ? "Terminal"
                : tab.type === "file"
                  ? tab.filePath.split("/").pop() ?? "File"
                  : new URL(tab.url).host;
            return (
              <div
                key={`${tab.type}-${i}`}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer border-r border-border whitespace-nowrap ${
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => onTabSelect(i)}
              >
                <span>{label}</span>
                {tab.type !== "terminal" && (
                  <button
                    className="ml-1 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTabClose(i);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
```

- [ ] **Step 4: タブに応じたコンテンツ切り替え**

ttyd iframeの既存div（`className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden"`）にdisplay制御を追加し、ファイル/ブラウザタブのコンテンツを追加:

既存のiframe div:
```tsx
      <div
        className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden"
        style={{ display: tabs[activeTabIndex]?.type === "terminal" ? undefined : "none" }}
      >
        {/* 既存のiframeコードをそのまま維持 */}
      </div>

      {/* ファイルビューワー / ブラウザ */}
      {tabs[activeTabIndex]?.type === "file" && (
        <div className="flex-1 min-h-0">
          <FileViewerPane
            filePath={(tabs[activeTabIndex] as any).filePath}
            content={(tabs[activeTabIndex] as any).content}
            mimeType={(tabs[activeTabIndex] as any).mimeType}
            size={(tabs[activeTabIndex] as any).size}
            targetLine={(tabs[activeTabIndex] as any).targetLine}
            error={(tabs[activeTabIndex] as any).error}
          />
        </div>
      )}
      {tabs[activeTabIndex]?.type === "browser" && (
        <div className="flex-1 min-h-0">
          <BrowserPane url={(tabs[activeTabIndex] as any).url} />
        </div>
      )}
```

注: TypeScriptの判別共用体の型絞り込みが `tabs[activeTabIndex]` のようなインデックスアクセスでは効かないため `as any` を使用。型安全性は `ViewerTab` の型定義で担保。

- [ ] **Step 5: ttyd iframe内へのリンクインジェクト**

`TerminalPane.tsx` に以下のuseEffectを追加（iframeRef, sessionの後の位置に配置）:

```tsx
  // ttyd iframe内のxterm.jsにリンク検出をインジェクト
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const injectLinkProvider = () => {
      try {
        const iframeWindow = iframe.contentWindow;
        if (!iframeWindow) return;

        // ttydがxterm.jsのTerminalインスタンスを公開するまで待つ
        const checkTerm = setInterval(() => {
          const term = (iframeWindow as any).term;
          if (!term || !term.registerLinkProvider) {
            return;
          }
          clearInterval(checkTerm);

          // 既にインジェクト済みならスキップ
          if ((iframeWindow as any).__arkLinkInjected) return;
          (iframeWindow as any).__arkLinkInjected = true;

          term.registerLinkProvider({
            provideLinks(lineNumber: number, callback: (links: any[] | undefined) => void) {
              const line = term.buffer.active.getLine(lineNumber - 1);
              if (!line) {
                callback(undefined);
                return;
              }
              const text = line.translateToString();
              const links: any[] = [];

              // ファイルパス検出: file:path:line または path/to/file.ext:line
              const fileRegex = /(?:file:)?([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+)(?::(\d+))?/g;
              let match;
              while ((match = fileRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const filePath = match[1];
                const lineNum = match[2] ? parseInt(match[2]) : null;

                // 最低限のフィルタ（パス区切りを含むか、file:プレフィックス付き）
                if (!filePath.includes("/") && !fullMatch.startsWith("file:")) continue;

                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: { x: match.index + fullMatch.length + 1, y: lineNumber },
                  },
                  text: fullMatch,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-file", path: filePath, line: lineNum },
                      window.location.origin
                    );
                  },
                });
              }

              // localhost URL検出
              const urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[/\w.\-?&=%#]*/g;
              while ((match = urlRegex.exec(text)) !== null) {
                const matchedUrl = match[0];
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: { x: match.index + matchedUrl.length + 1, y: lineNumber },
                  },
                  text: matchedUrl,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-url", url: matchedUrl },
                      window.location.origin
                    );
                  },
                });
              }

              callback(links.length > 0 ? links : undefined);
            },
          });
        }, 500);

        // 10秒でタイムアウト
        setTimeout(() => clearInterval(checkTerm), 10000);
      } catch {
        // クロスオリジンエラー等は無視
      }
    };

    iframe.addEventListener("load", injectLinkProvider);
    // 既にロード済みの場合も実行
    if (iframe.contentDocument?.readyState === "complete") {
      injectLinkProvider();
    }

    return () => {
      iframe.removeEventListener("load", injectLinkProvider);
    };
  }, [iframeKey]);
```

- [ ] **Step 6: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add client/src/components/TerminalPane.tsx
git commit -m "feat: TerminalPaneにタブバーとxterm.jsリンクインジェクトを追加"
```

---

### Task 9: Dashboard.tsxでタブ状態管理とpostMessageリスナー

**Files:**
- Modify: `client/src/pages/Dashboard.tsx`

- [ ] **Step 1: ViewerTabのimportを追加**

```typescript
import type { ViewerTab } from "../components/TerminalPane";
```

- [ ] **Step 2: タブ状態管理を追加**

Dashboard.tsx のstate定義セクション（`selectedSessionId` 付近）に以下を追加:

```typescript
  // タブ管理: セッションIDごとのタブ配列とアクティブタブ
  const [sessionTabs, setSessionTabs] = useState<Record<string, ViewerTab[]>>({});
  const [sessionActiveTab, setSessionActiveTab] = useState<Record<string, number>>({});
```

- [ ] **Step 3: タブ操作ヘルパー関数を追加**

```typescript
  const getTabsForSession = useCallback(
    (sessionId: string): ViewerTab[] => {
      return sessionTabs[sessionId] ?? [{ type: "terminal" }];
    },
    [sessionTabs]
  );

  const getActiveTabForSession = useCallback(
    (sessionId: string): number => {
      return sessionActiveTab[sessionId] ?? 0;
    },
    [sessionActiveTab]
  );

  const handleTabSelect = useCallback(
    (sessionId: string, index: number) => {
      setSessionActiveTab((prev) => ({ ...prev, [sessionId]: index }));
    },
    []
  );

  const handleTabClose = useCallback(
    (sessionId: string, index: number) => {
      setSessionTabs((prev) => {
        const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
        tabs.splice(index, 1);
        return { ...prev, [sessionId]: tabs };
      });
      setSessionActiveTab((prev) => {
        const current = prev[sessionId] ?? 0;
        if (current >= index && current > 0) {
          return { ...prev, [sessionId]: current - 1 };
        }
        return prev;
      });
    },
    []
  );

  const openFileTab = useCallback(
    (sessionId: string, filePath: string, targetLine?: number | null) => {
      setSessionTabs((prev) => {
        const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
        // 既に同じファイルが開いている場合はそのタブにフォーカス
        const existing = tabs.findIndex(
          (t) => t.type === "file" && t.filePath === filePath
        );
        if (existing >= 0) {
          const tab = tabs[existing];
          if (tab.type === "file") {
            tabs[existing] = { ...tab, targetLine };
          }
          setSessionActiveTab((p) => ({ ...p, [sessionId]: existing }));
          return { ...prev, [sessionId]: tabs };
        }
        // 新しいタブを追加（ロード中はcontentなし）
        tabs.push({
          type: "file",
          filePath,
          content: "",
          mimeType: "text/plain",
          size: 0,
          targetLine,
        });
        setSessionActiveTab((p) => ({ ...p, [sessionId]: tabs.length - 1 }));
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );

  const openBrowserTab = useCallback(
    (sessionId: string, url: string) => {
      setSessionTabs((prev) => {
        const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
        // 既に同じURLが開いている場合はそのタブにフォーカス
        const existing = tabs.findIndex(
          (t) => t.type === "browser" && t.url === url
        );
        if (existing >= 0) {
          setSessionActiveTab((p) => ({ ...p, [sessionId]: existing }));
          return prev;
        }
        tabs.push({ type: "browser", url });
        setSessionActiveTab((p) => ({ ...p, [sessionId]: tabs.length - 1 }));
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );
```

- [ ] **Step 4: postMessageリスナーを追加**

Dashboard.tsx に以下のuseEffectを追加:

```typescript
  // ttyd iframe内からのリンククリックイベントをリスン
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // オリジン検証
      if (event.origin !== window.location.origin) return;

      const { type } = event.data ?? {};
      if (!selectedSessionId) return;

      const session = sessions.get(selectedSessionId);
      if (!session) return;

      if (type === "ark:open-file") {
        const { path: filePath, line } = event.data;
        openFileTab(selectedSessionId, filePath, line);
        // サーバーにファイル読み取りをリクエスト
        readFile(session.worktreePath, filePath);
      } else if (type === "ark:open-url") {
        const { url } = event.data;
        openBrowserTab(selectedSessionId, url);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [selectedSessionId, sessions, openFileTab, openBrowserTab, readFile]);
```

- [ ] **Step 5: fileContent受信時にタブを更新**

```typescript
  // ファイル内容を受信したらタブを更新
  useEffect(() => {
    if (!fileContent || !selectedSessionId) return;
    setSessionTabs((prev) => {
      const tabs = [...(prev[selectedSessionId] ?? [{ type: "terminal" as const }])];
      const idx = tabs.findIndex(
        (t) => t.type === "file" && t.filePath === fileContent.filePath
      );
      if (idx >= 0) {
        const existingTab = tabs[idx];
        tabs[idx] = {
          type: "file",
          filePath: fileContent.filePath,
          content: fileContent.content,
          mimeType: fileContent.mimeType,
          size: fileContent.size,
          targetLine: existingTab.type === "file" ? existingTab.targetLine : undefined,
          error: fileContent.error,
        };
        return { ...prev, [selectedSessionId]: tabs };
      }
      return prev;
    });
  }, [fileContent, selectedSessionId]);
```

- [ ] **Step 6: TerminalPaneへのprops追加**

Dashboard.tsxのTerminalPaneのJSX（行281-310付近）にタブ関連のpropsを追加:

```tsx
        <TerminalPane
          session={session}
          worktree={wt}
          repoName={rn}
          tabs={getTabsForSession(session.id)}
          activeTabIndex={getActiveTabForSession(session.id)}
          onTabSelect={(idx) => handleTabSelect(session.id, idx)}
          onTabClose={(idx) => handleTabClose(session.id, idx)}
          onSendMessage={msg => sendMessage(session.id, msg)}
          onSendKey={key => sendKey(session.id, key)}
          onStopSession={() => handleStopSession(session.id)}
          onUploadImage={(base64, mimeType) => uploadImage(session.id, base64, mimeType)}
          imageUploadResult={imageUploadResult}
          imageUploadError={imageUploadError}
          onClearImageUploadState={clearImageUploadState}
          onCopyBuffer={copyBuffer ? () => copyBuffer(session.id) : undefined}
        />
```

- [ ] **Step 7: useSocketからreadFile, fileContentをdestructure**

useSocket呼び出し箇所に `readFile`, `fileContent` を追加:

```typescript
  const {
    // ... 既存の値
    readFile,
    fileContent,
  } = useSocket({...});
```

- [ ] **Step 8: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 9: コミット**

```bash
git add client/src/pages/Dashboard.tsx
git commit -m "feat: Dashboardにタブ状態管理とpostMessageリスナーを追加"
```

---

### Task 10: モバイル対応（MobileSessionView.tsx + MobileLayout.tsx）

**Files:**
- Modify: `client/src/components/MobileSessionView.tsx`
- Modify: `client/src/components/MobileLayout.tsx`

- [ ] **Step 1: MobileSessionViewにタブpropsを追加**

`MobileSessionViewProps` に以下を追加:

```typescript
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
```

import追加:

```typescript
import type { ViewerTab } from "./TerminalPane";
import { FileViewerPane } from "./FileViewerPane";
import { BrowserPane } from "./BrowserPane";
```

- [ ] **Step 2: タブバーUIをMobileSessionViewに追加**

ヘッダーとttyd iframeの間（行342-345付近）にタブバーを追加（Task 8 Step 3と同じマークアップ）。

- [ ] **Step 3: タブに応じたコンテンツ切り替え**

ttyd iframeのdiv（行345-375付近）にdisplay制御を追加し、ファイル/ブラウザタブのコンテンツを追加（Task 8 Step 4と同じパターン）。

- [ ] **Step 4: MobileSessionViewにリンクインジェクトのuseEffectを追加**

Task 8 Step 5と同じリンクインジェクトコードを追加（iframeRefとiframeKeyを参照）。

- [ ] **Step 5: MobileLayoutにタブ状態管理を追加**

`MobileLayout.tsx` に以下を追加:

- `sessionTabs`, `sessionActiveTab` state（Task 9 Step 2と同じ）
- `getTabsForSession`, `getActiveTabForSession`, `handleTabSelect`, `handleTabClose`, `openFileTab`, `openBrowserTab` ヘルパー（Task 9 Step 3と同じ）
- postMessageリスナーuseEffect（Task 9 Step 4と同じ）
- fileContent受信時のタブ更新useEffect（Task 9 Step 5と同じ）
- MobileSessionViewにタブpropsを渡す

- [ ] **Step 6: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add client/src/components/MobileSessionView.tsx client/src/components/MobileLayout.tsx
git commit -m "feat: モバイル版にもタブバーとファイルビューワーを追加"
```

---

### Task 11: ローカルポートプロキシ（server/index.ts）

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: プロキシエンドポイントを追加**

`server/index.ts` の既存のttydプロキシ設定の近くに、ローカルポートプロキシを追加。既存の `proxy` 変数（http-proxyインスタンス）を再利用:

```typescript
// ローカルポートプロキシ（リモートアクセス時にlocalhost URLを表示するため）
app.all("/proxy/:port/*", (req, res) => {
  const port = parseInt(req.params.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: "Invalid port" });
    return;
  }

  // /proxy/3000/path/to/resource → http://127.0.0.1:3000/path/to/resource
  const targetPath = req.url.replace(`/proxy/${port}`, "") || "/";
  req.url = targetPath;

  proxy.web(req, res, { target: `http://127.0.0.1:${port}` }, (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Proxy error" });
    }
  });
});
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add server/index.ts
git commit -m "feat: リモートアクセス時のローカルポートプロキシを追加"
```

---

### Task 12: 統合ビルドと動作確認

**Files:** なし（テスト実行のみ）

- [ ] **Step 1: フルビルド確認**

Run: `pnpm build`
Expected: エラーなし

- [ ] **Step 2: ブラウザでの動作確認項目**

以下を手動で確認:
1. ターミナルでClaudeを実行し、`file:path:line` 形式の出力がリンクになること
2. リンクにホバーするとハイライトされること
3. ファイルリンクをクリックするとファイルビューワータブが開くこと
4. `.md` ファイルがMarkdownとしてレンダリングされること
5. `.ts`/`.tsx` ファイルがシンタックスハイライトされること
6. 指定行がハイライト表示されること
7. `localhost:XXXX` リンクをクリックするとブラウザタブが開くこと
8. タブの×ボタンで閉じられること
9. Terminalタブに戻れること
10. モバイルでも同じ操作が可能なこと

- [ ] **Step 3: 最終調整があればコミット**

```bash
git add -A
git commit -m "fix: ファイルビューワー統合テストでの修正"
```
