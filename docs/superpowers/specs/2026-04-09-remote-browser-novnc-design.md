# リモートアクセス時のブラウザタブ noVNC方式設計

## 背景・課題

GitHub Issue: #60

Cloudflare Tunnel経由（リモートアクセス）でArkを使用時、ブラウザタブで`http://localhost:PORT`を表示するとCSSが効かない。

### 原因

パスベースプロキシ（`/proxy/PORT/`）では、HTML内のCSS/JS参照が絶対パス（`/style.css`等）の場合、Arkサーバー本体に解決されてしまう。

```
iframe src="/proxy/3330/"
  → HTMLに <link href="/style.css">
  → ブラウザが https://ccm.ignission.tech/style.css をリクエスト
  → 404
```

ローカルアクセス時はiframeが`http://localhost:PORT`を直接読み込むため問題なし。

### 要件

- 任意のlocalhostアプリ（Vite, Next.js, 静的サイト等）がリモートでも完璧に動作すること
- プレビュー確認とDevTools検査の両方に対応すること
- モバイルからも利用可能であること

## 解決アプローチ: noVNC方式

パスの書き換え問題を根本的に回避する。ローカルでHeadless Chromiumが`http://localhost:PORT`に直接アクセスし、その描画結果をVNC経由でリモートに転送する。

### 検討した他のアプローチ

| アプローチ | 却下理由 |
|-----------|---------|
| `<base href>` タグ注入 | SPAのルーティングが壊れる |
| HTML書き換え改良版 | gzip対応、SPA対応等が複雑。完全性を保証できない |
| Service Worker | 全てのfetchをインターセプトする複雑さ。WebSocket等に非対応 |
| CDP Screencast | カスタムViewer実装が必要。ドラッグ&ドロップ等の操作再現が不完全 |
| サブドメインプロキシ | Quick Tunnelで使えない。DNS/SSL事前設定が必要 |
| ポートごとにCloudflare Tunnel | リソース消費大。管理が複雑 |

## アーキテクチャ

### プロセス構成

ポートごとに以下のプロセスセットが起動される:

```
┌─ BrowserSession (ポート3000の例) ─────────────────────────┐
│                                                              │
│  Xvfb :99+N       仮想ディスプレイ (1280x900)               │
│    └── Chromium    http://localhost:3000 を表示             │
│  x11vnc :5900+N   仮想ディスプレイをVNC公開                  │
│  websockify :6080+N VNC→WebSocket変換（noVNCクライアント用） │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### データフロー

```
[リモートブラウザ]
    ↕ HTTPS/WSS (Cloudflare Tunnel)
[Ark Server]
    ↕ /browser/:browserId/* (HTTP Proxy → websockify)
[websockify :6080+N]
    ↕ VNC protocol
[x11vnc]
    ↕ X11
[Xvfb :99+N]
    └── Chromium → http://localhost:PORT (直接アクセス)
```

### 既存アーキテクチャとの並行関係

| リソース | ttyd方式（既存） | noVNC方式（新規） |
|---------|-----------------|-------------------|
| プロセス管理 | `TtydManager` | `BrowserManager`（新規） |
| ポート範囲 | 7680-7780 (ttyd) | 5900-5999 (VNC) + 6080-6179 (websockify) |
| プロキシパス | `/ttyd/:sessionId` | `/browser/:browserId` |
| iframe src | `/ttyd/{id}/` | `/browser/{id}/vnc.html` |
| 統合 | `SessionOrchestrator` | `SessionOrchestrator`に追加 |

## サーバー側設計

### BrowserManager

`server/lib/browser-manager.ts` に新規作成。`TtydManager` と同じパターンに従う。

#### ライフサイクル

```
BrowserManager.start(port, url?)
  ↓
1. Xvfb 起動 (ディスプレイ番号を自動割り当て :99+N)
2. Chromium 起動 (DISPLAY=:99+N, --no-sandbox, http://localhost:PORT)
3. x11vnc 起動 (ディスプレイ :99+N をVNC公開, ポート 5900+N)
4. websockify 起動 (ポート 6080+N → localhost:5900+N, --web でnoVNC静的ファイル配信)
  ↓
BrowserSession { browserId, wsPort, vncPort, displayNum }
```

#### 停止

```
BrowserManager.stop(browserId)
  ↓
1. websockify を kill
2. x11vnc を kill
3. Chromium を kill
4. Xvfb を kill
5. BrowserSession を削除
```

サーバー再起動時は全BrowserSessionを停止（永続化不要。ブラウザプレビューは一時的なもの）。

### ポート管理

| 用途 | 範囲 | 備考 |
|------|------|------|
| ttyd (既存) | 7680-7780 | セッション用 |
| VNC (新規) | 5900-5999 | x11vnc用、最大100同時 |
| WebSocket (新規) | 6080-6179 | websockify用 |
| Xvfb display | :99-:198 | 仮想ディスプレイ番号 |

### プロキシルート

```typescript
// noVNC静的ファイル + websockify WebSocket
app.use("/browser/:browserId", (req, res) => {
  const session = browserManager.getSession(browserId);
  if (!session) { res.status(404).json({ error: "Browser session not found" }); return; }
  
  req.url = req.originalUrl;
  ttydProxy.web(req, res, { target: `http://127.0.0.1:${session.wsPort}` });
});

// WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  const browserMatch = pathname.match(/^\/browser\/([^/]+)(\/.*)?$/);
  if (browserMatch) {
    const session = browserManager.getSession(browserMatch[1]);
    if (session) {
      req.url = browserMatch[2] || "/";
      ttydProxy.ws(req, socket, head, { target: `ws://127.0.0.1:${session.wsPort}` });
      return;
    }
    socket.destroy();
    return;
  }
});
```

### Socket.IO イベント

| 方向 | イベント | データ | 説明 |
|------|---------|--------|------|
| C→S | `browser:start` | `{ port, url? }` | ブラウザセッション起動 |
| C→S | `browser:stop` | `{ browserId }` | ブラウザセッション停止 |
| C→S | `browser:navigate` | `{ browserId, url }` | URL変更 |
| S→C | `browser:started` | `BrowserSession` | 起動完了 |
| S→C | `browser:stopped` | `{ browserId }` | 停止完了 |
| S→C | `browser:error` | `{ message }` | エラー |

## クライアント側設計

### ローカル/リモート自動判定

```
ローカルアクセス (localhost / 127.0.0.1):
  → 従来通り iframe src="http://localhost:PORT" で直接表示

リモートアクセス (*.trycloudflare.com 等):
  → BrowserSession を起動し、noVNC iframe で表示
```

### BrowserPane.tsx の変更

```typescript
function BrowserPane({ url, port }) {
  const isRemote = !isLocalAccess();

  if (!isRemote) {
    return <iframe src={url} />;
  }

  // リモート: noVNCセッションを起動してiframe表示
  const [browserSession, setBrowserSession] = useState(null);
  
  useEffect(() => {
    socket.emit("browser:start", { port, url });
    socket.on("browser:started", (session) => setBrowserSession(session));
    return () => socket.emit("browser:stop", { browserId: session.id });
  }, [port, url]);

  if (!browserSession) return <LoadingSpinner />;
  
  const token = getUrlToken();
  const vncUrl = token
    ? `/browser/${browserSession.id}/vnc.html?token=${token}&autoconnect=true&resize=scale`
    : `/browser/${browserSession.id}/vnc.html?autoconnect=true&resize=scale`;
    
  return <iframe src={vncUrl} />;
}
```

### モバイル対応

noVNCは `scaleViewport` オプションで画面をフィットさせる。モバイルのタッチ操作はnoVNCが内蔵するタッチ→マウス変換で対応。既存の `MobileSessionView` からそのまま利用可能。

## 依存関係

### システム依存

```bash
# Ubuntu/Debian
sudo apt install xvfb x11vnc chromium-browser
pip install websockify
```

### セットアップスクリプト

```bash
#!/bin/bash
# scripts/setup-browser.sh
echo "Installing browser tab dependencies..."
sudo apt install -y xvfb x11vnc chromium-browser
pip install websockify
echo "Done. Browser tab feature is now available."
```

### 起動時バリデーション

`BrowserManager` の初期化時に `which xvfb-run`, `which x11vnc`, `which websockify`, `which chromium-browser` で存在チェック。不足していたらブラウザタブ機能をdisableにして警告ログを出力（Ark全体の起動は妨げない）。

## エラーハンドリング

| ケース | 対応 |
|--------|------|
| 依存ツール未インストール | ブラウザタブ機能をdisable。UIに「要セットアップ」と表示 |
| ポートが使用中 | 次の空きポートを自動選択 |
| ターゲットポートが未起動 | Chromiumがエラーページを表示 → noVNC経由でユーザーに見える |
| Xvfb起動失敗 | `browser:error` イベントで通知 |
| プロセスクラッシュ | 子プロセスの `exit` イベント監視 → 自動クリーンアップ |

## DevTools対応

Chromiumを `--auto-open-devtools-for-tabs` フラグ付きで起動するオプションを提供。DevToolsが開いた状態の画面がそのままnoVNC経由で転送される。

UIにはトグルスイッチを用意:
```
[ブラウザタブを開く]  □ DevToolsも表示
```

## 解像度

デフォルト `1280x900`。Xvfbの解像度はセッション作成時にオプションで指定可能。

## セキュリティ

- websockifyはループバックインターフェース（`127.0.0.1`）のみでリッスン
- x11vncもループバックのみ
- 外部からのアクセスはArkのプロキシ経由のみ（既存の認証が適用される）
- SSRF対策: `/browser/:browserId` ルートはBrowserManagerに登録されたセッションのみ許可

## ファイル構成（変更・新規）

```
server/lib/
├── browser-manager.ts      # 新規: Xvfb + Chromium + x11vnc + websockify管理
├── session-orchestrator.ts  # 変更: BrowserManager統合
└── constants.ts             # 変更: VNC/WebSocketポート範囲定数追加

server/index.ts              # 変更: /browser/:browserId プロキシルート追加

client/src/components/
├── BrowserPane.tsx           # 変更: ローカル/リモート切り替えロジック

shared/types.ts              # 変更: BrowserSession型追加

scripts/
└── setup-browser.sh         # 新規: 依存インストールスクリプト
```
