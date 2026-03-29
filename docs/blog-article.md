---
title: "Claude Code Managerを支える技術 — iPhoneからClaude Codeを操作するまで"
emoji: "📱"
type: "tech"
topics: ["claudecode", "typescript", "cloudflare", "tmux"]
published: false
---

## はじめに

Claude Codeを日常的に使っていると、「複数のタスクを並列で走らせたい」「外出先からiPhoneで進捗を確認したい」という欲求が自然と生まれてくる。ターミナルで1つずつ操作するのも悪くないが、4つのClaude Codeを同時に走らせてブラウザから一覧できたら、開発効率は大きく変わるはずだ。

**Claude Code Manager**は、複数のClaude Codeインスタンスをブラウザ上のWebUIから管理するツールである。git worktreeごとにClaude Codeセッションを起動し、2x2グリッドで同時に表示でき、さらにCloudflare Tunnelを通じてiPhoneからも操作できる。

https://github.com/ignission/claude-code-manager

この記事では、Claude Code Managerの設計判断と、その裏にある技術的な課題と解決策を解説する。

## 最初の設計判断: Agent SDK vs ターミナル転送

Claude Code Managerの開発初期に、大きな分岐点があった。Claude Agent SDKを使ってブラウザ上にチャットUIを構築する方法と、ターミナルをそのままブラウザに転送する方法の二択である。

Agent SDKを使えば、`send()` / `stream()` でClaude Codeとやりとりし、メッセージを自前のReactコンポーネントでレンダリングできる。一見クリーンな設計に見えるが、実際にはClaude Codeの体験をブラウザ上で再現するのが想像以上に困難だった。

- ツール承認のy/n確認ダイアログ
- スラッシュコマンド（`/compact`, `/resume`, `/clear` など）
- ファイル編集時の差分表示
- ストリーミング出力のリアルタイム表示
- エラー時のリカバリフロー

これらすべてをSDKのメッセージから解釈して独自UIに変換するのは、膨大な工数がかかる。そこで発想を転換した。「Claude Codeのターミナル出力をそのままブラウザに映せばいい」。

最終的に、**tmuxでセッションを管理し、ttydでWebターミナルとしてブラウザに転送する**アーキテクチャに決定した。Claude Codeのフル機能がそのまま使えるうえ、ターミナルの表示品質もttydが担保してくれる。

## 全体アーキテクチャ

システム全体の構成を示す。

```
iPhone / PC ブラウザ
    ↓ HTTPS (Cloudflare Tunnel)
Tart 仮想マシン (macOS / Linux)
    ├── Express Server (port 3001)
    │   ├── Socket.IO (セッション管理・コマンド送信)
    │   ├── http-proxy (ttyd WebSocket転送)
    │   └── React SPA (静的ファイル配信)
    ├── tmux (Claude Codeセッション管理)
    │   ├── ccm-abc123 → claude (worktree A)
    │   ├── ccm-def456 → claude (worktree B)
    │   └── ccm-ghi789 → claude (worktree C)
    ├── ttyd (各セッションのWebターミナル)
    │   ├── port 7680 → tmux attach ccm-abc123
    │   ├── port 7681 → tmux attach ccm-def456
    │   └── port 7682 → tmux attach ccm-ghi789
    └── cloudflared (Cloudflare Quick Tunnel)
```

技術スタックは、フロントエンドがReact 19 + TailwindCSS 4 + shadcn/ui、バックエンドがExpress + Socket.IO、セッション管理がtmux + ttyd、リモートアクセスがCloudflare Tunnelという構成になっている。

## ブラウザ上でターミナルを動かしたい

### 問題: Claude Codeはターミナルアプリケーション

Claude Codeの出力はANSIエスケープシーケンスを含むリッチなターミナル出力である。これをブラウザ上で再現するには、xterm.jsとWebSocketで自前実装する方法もあるが、ターミナルエミュレーションの品質を保つのは複雑すぎる。

### 解決策: ttydでターミナルをそのまま転送

[ttyd](https://github.com/tsl0922/ttyd)は、任意のコマンドをWeb上のターミナルとして公開するツールである。内部でxterm.jsを使っており、ターミナルの表示品質は保証済み。各Claude Codeセッションごとに1つのttydプロセスを起動し、フロントエンドではiframeで表示するだけというシンプルな構成になっている。

```typescript
const ttydProcess = spawn("ttyd", [
  "-W", // クライアント入力を許可
  "-p",
  port.toString(),
  "-i",
  process.platform === "darwin" ? "lo0" : "lo", // ループバック
  "--base-path",
  `/ttyd/${sessionId}`,
  "tmux",
  "attach-session",
  "-t",
  tmuxSessionName,
]);
```

### 技術的なハマりどころ

**1. ループバックインターフェース名の違い**

ttydの`-i`オプションでバインド先インターフェースを指定するが、macOSは`lo0`、Linuxは`lo`と名前が異なる。些細な違いだが、クロスプラットフォーム対応では見落としがちなポイントである。

```typescript
process.platform === "darwin" ? "lo0" : "lo";
```

**2. WebSocket転送の罠**

ttydはWebSocket接続を使うため、Express + http-proxyでHTTPリクエストとWebSocketの両方を転送する必要がある。ここで注意すべきは、Expressの`app.use`がマウントパスを自動的に削除すること。`/ttyd/abc123/index.html`にリクエストが来た場合、Expressはハンドラ内で`req.url`を`/index.html`に書き換えてしまう。ttydはフルパスでリクエストを受け付けるため、`originalUrl`で上書きが必要になる。

```typescript
// Expressがマウントパスを削除するため、originalUrlで上書き
app.use("/ttyd/:sessionId", (req, res) => {
  req.url = req.originalUrl;
  ttydProxy.web(req, res, {
    target: `http://127.0.0.1:${session.ttydPort}`,
  });
});
```

WebSocketのupgradeリクエストは`app.use`を経由しないため、`server.on("upgrade")`で手動ルーティングが必要になる。

```typescript
server.on("upgrade", (req, socket, head) => {
  const ttydMatch = pathname.match(/^\/ttyd\/([^/]+)/);
  if (ttydMatch) {
    ttydProxy.ws(req, socket, head, {
      target: `ws://127.0.0.1:${session.ttydPort}`,
    });
  }
});
```

**3. ポート管理と重複起動防止**

各ttydインスタンスは7680〜7780の範囲で異なるポートを使用する。複数のクライアントが同時接続した場合に同じセッションのttydが二重起動されないよう、`pendingStarts`マップで起動中のPromiseを管理している。

```typescript
async startInstance(sessionId: string, tmuxSessionName: string) {
  // 既に起動済み
  const existing = this.instances.get(sessionId);
  if (existing) return existing;

  // 起動中のPromiseがあれば、それを待つ
  const pending = this.pendingStarts.get(sessionId);
  if (pending) return pending;

  const promise = this._startInstanceInternal(sessionId, tmuxSessionName);
  this.pendingStarts.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    this.pendingStarts.delete(sessionId);
  }
}
```

**4. セッション永続化**

tmuxセッションはサーバープロセスとは独立して生存する。サーバーを再起動しても、tmuxセッション内のClaude Codeはそのまま動き続けている。起動時に`tmux list-sessions`で既存セッションを検出し、ttydを再起動して復元する。

```typescript
private discoverExistingSessions(): void {
  const output = execSync('tmux list-sessions -F "#{session_name}"', {
    encoding: "utf-8",
  });
  const sessionNames = output.trim().split("\n").filter(Boolean);
  for (const name of sessionNames) {
    if (name.startsWith(this.SESSION_PREFIX)) {
      // 既存セッションを登録
    }
  }
}
```

ただし、ttydプロセスはサーバーと一緒に死ぬため、再起動前に`pkill -f ttyd`でプロセスを掃除しないとポート競合が起きる。これはデプロイ手順に組み込んである。

## 複数のClaude Codeを同時に走らせたい

### 問題: 同一リポジトリでの並行作業

1つのプロジェクトで「テストの追加」「リファクタリング」「新機能の実装」を同時に進めたい場面は多い。しかし、同じディレクトリに対して複数のClaude Codeを起動すると、ファイル変更が衝突してカオスになる。

### 解決策: git worktree + マルチペインレイアウト

git worktreeを使えば、同じリポジトリのブランチを別ディレクトリにチェックアウトできる。各worktreeに対してClaude Codeセッションを起動すれば、並行作業でもファイル衝突が起きない。

WebUI上では2カラムのグリッドレイアウトで複数セッションを同時表示する。各ペインにttydのiframeが埋め込まれ、すべてのClaude Codeの出力をリアルタイムで確認できる。

### SessionOrchestratorパターン

セッションの起動には「tmuxセッション作成 → claudeコマンド実行 → ttyd起動 → DB保存」という複数ステップが必要になる。これらを統合管理するのがSessionOrchestratorである。

```typescript
async startSession(worktreeId: string, worktreePath: string) {
  // 既存セッションがあれば再利用
  const existingTmux = tmuxManager.getSessionByWorktree(worktreePath);
  if (existingTmux) {
    let ttydInstance = ttydManager.getInstance(existingTmux.id);
    if (!ttydInstance) {
      ttydInstance = await ttydManager.startInstance(
        existingTmux.id,
        existingTmux.tmuxSessionName
      );
    }
    return this.toManagedSession(existingTmux, worktreeId);
  }

  // 新規: tmux → ttyd → DB の順で作成
  const tmuxSession = await tmuxManager.createSession(worktreePath);
  const ttydInstance = await ttydManager.startInstance(
    tmuxSession.id, tmuxSession.tmuxSessionName
  );
  db.createSession({
    id: tmuxSession.id, worktreeId, worktreePath, status: "active",
  });
  // ...
}
```

tmuxManagerとttydManagerを内部に持ち、クライアントには`ManagedSession`という統合されたインターフェースだけを見せる設計にしている。クライアント再接続時の自動復元も、tmuxセッションの検出 → ttyd再起動という流れをOrchestratorが一元管理する。

### ペイン状態の永続化

localStorageにどのセッションをどのペインで開いていたかを保存しており、ブラウザをリロードしてもペイン配置が復元される。複数のリポジトリにまたがるセッションも同時管理可能で、各ペインのヘッダーにリポジトリ名が表示される。

## リモートアクセスを安全にしたい

### 問題: むき出しのターミナルを外部に公開する危険性

Claude Codeはターミナル上でファイル編集やコマンド実行ができるため、リモートアクセスを許可するということは、マシンへのシェルアクセスを開放するのに等しい。SSH接続を外部に直接開放するのは論外だが、WebUI経由でも同様のリスクがある。

### 解決策1: Tart仮想マシンでサンドボックス化

[Tart](https://github.com/cirruslabs/tart)で仮想マシン（macOSまたはLinux）を作成し、その中でClaude Code Managerを動かす。万が一侵入されても被害は仮想マシン内に限定され、ホストマシンのファイルシステムやネットワークからは隔離される。

### 解決策2: Cloudflare Quick Tunnelで一時的な公開

ローカルで起動したExpressサーバーには外部からアクセスできない。Cloudflare Quick Tunnelを使えば、`*.trycloudflare.com`ドメインで一時的に公開できる。サーバーを再起動するたびにURLが変わるため、永続的な攻撃対象になりにくい。

`tunnel.ts`では、cloudflaredプロセスのstderrからURLを検出している。

```typescript
// cloudflaredはURLをstderrに出力する
const urlMatch = outputBuffer.match(
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
);
if (urlMatch && !urlFound) {
  urlFound = true;
  this.publicUrl = urlMatch[0];
  this.emit("url", this.publicUrl);
  resolve(this.publicUrl);
}
```

cloudflaredの出力をパースするのは少々泥臭いが、Quick Tunnelは設定ファイルもDNS設定も不要で即座に使えるため、個人開発ツールには最適な選択だった。

### 解決策3: トークン認証

Quick TunnelのURLを知っていれば誰でもアクセスできてしまうため、ランダム生成されたトークンをURLのクエリパラメータに含める形式で認証を実装している。

```typescript
// ランダムな認証トークンを生成
private generateToken(): string {
  return randomBytes(16).toString("hex");
}

// タイミング攻撃を防ぐためtimingSafeEqualで比較
validateToken(token: string | undefined): boolean {
  if (!this.enabled) return true;
  if (!token) return false;
  const received = Buffer.from(token, "utf8");
  const expected = Buffer.from(this.token, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
```

ポイントは、Quick Tunnel経由のアクセスのみ認証を要求し、localhostからの直接アクセスは認証をスキップすること。開発中にいちいちトークンを入力する手間が省ける。起動時にターミナルにQRコードが表示されるので、iPhoneでスキャンするだけでトークン付きURLにアクセスできる。

### トンネル自動復旧

サーバーを再起動するとトンネルが切れてしまう問題があった。`/tmp/ccm-tunnel-state.json`にトンネルの状態を保存し、サーバー起動時に前回トンネルが有効だったことを検出すると自動で再起動する仕組みを入れている。

```typescript
// トンネル自動復旧: 前回トンネルが有効だった場合に自動起動
if (!activeTunnel) {
  const savedState = loadTunnelState();
  if (savedState) {
    const url = await startQuickTunnelShared(savedState.port);
    await printRemoteAccessInfo(url, tunnelToken!);
  }
}
```

pm2でプロセス管理している場合、クラッシュ時の自動再起動でもトンネルが復旧するため、リモートアクセスの可用性が大幅に向上した。

## iPhoneからでも快適に使いたい

ここが最も泥臭いパートである。ttydのターミナルはiPhoneのSafariでも表示できるが、そのままでは操作性が壊滅的に悪い。具体的には以下の問題がある。

- ソフトウェアキーボードが画面を覆い、ターミナルが見えなくなる
- Claude Codeのy/n確認やCtrl+Cなどの特殊キーが打てない
- iframeのタッチイベントがttydに吸われ、スクロールできない
- 日本語入力時にEnterで変換確定ではなく送信されてしまう

### visualViewport APIでキーボード対応

iPhoneのSafariでソフトウェアキーボードが表示されると、ビューポートが縮小する。`window.visualViewport`のresize/scrollイベントを監視し、キーボード表示時にレイアウト全体の高さを動的に調整する。

```typescript
export function useVisualViewport(): VisualViewportState {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const isKeyboardVisible = viewport.height < window.innerHeight * 0.75;
      setState({
        height: viewport.height,
        offsetTop: viewport.offsetTop,
        isKeyboardVisible,
      });
    };

    viewport.addEventListener("resize", handleResize);
    viewport.addEventListener("scroll", handleResize);
    return () => {
      viewport.removeEventListener("resize", handleResize);
      viewport.removeEventListener("scroll", handleResize);
    };
  }, []);
}
```

`viewport.height < window.innerHeight * 0.75`という判定は、キーボードが画面の25%以上を占めたら「表示されている」と見なすヒューリスティクスである。MobileSessionViewコンポーネントでは、この値をもとにコンテナの高さを動的に設定している。

```tsx
<div
  style={isKeyboardVisible
    ? { height: `${viewportHeight}px`, maxHeight: `${viewportHeight}px` }
    : undefined
  }
>
```

### Quick Keysバー

Claude Codeを使っていると、ツール承認の`y`/`n`やキャンセルの`Ctrl+C`を頻繁に入力する。iPhoneのソフトウェアキーボードでCtrl+Cを打つのは現実的ではないため、Quick Keysバーを常時表示している。

y / n / Esc / Ctrl+C / S-Tab のボタンをワンタップで送信できる。内部的にはSocket.IO経由でサーバーに送信し、tmuxの`send-keys`コマンドで特殊キーをセッションに転送している。

```typescript
sendSpecialKey(sessionId: string, key: SpecialKey): void {
  const session = this.sessions.get(sessionId);
  // S-Tab はtmuxでは "BTab" として送信
  const keyMap: Partial<Record<SpecialKey, string>> = {
    "S-Tab": "BTab",
    "scroll-up": "Up",
    "scroll-down": "Down",
  };
  const tmuxKey = keyMap[key] ?? key;
  spawnSync("tmux", [
    "send-keys", "-t", session.tmuxSessionName, tmuxKey
  ]);
}
```

### スワイプスクロール

ttydのiframe内はタッチ操作でスクロールできない。iframeのタッチイベントがttydのxterm.jsに吸われてしまうためである。

解決策として「Scrollモード」トグルボタンを用意した。ONにするとtmuxの`copy-mode`に入り、iframe上に透明なオーバーレイを表示する。オーバーレイ上のタッチスワイプを検出し、移動距離に応じてUp/Downキーに変換してtmuxに送信する。

```typescript
const handleOverlayTouchMove = useCallback(
  (e: React.TouchEvent) => {
    const state = swipeStateRef.current;
    if (!state) return;
    e.preventDefault();
    const touch = e.touches[0];
    const deltaY = state.startY - touch.clientY;
    const totalLines = Math.floor(Math.abs(deltaY) / LINE_HEIGHT);
    const newLines = totalLines - state.sentLines;
    if (newLines > 0) {
      const key: SpecialKey = deltaY > 0 ? "scroll-up" : "scroll-down";
      for (let i = 0; i < newLines; i++) {
        onSendKey(key);
      }
      state.sentLines = totalLines;
    }
  },
  [onSendKey]
);
```

20pxごとに1行分のスクロールを送信する実装で、指の移動量に応じた直感的なスクロールが実現できている。

### iframe再マウント防止

モバイルでは「セッション一覧」と「セッション詳細」を画面遷移で切り替える。Reactの通常の条件レンダリングではiframeがアンマウント → 再マウントされ、ttydの再接続が走ってしまう。

これを防ぐため、`display: none/block`で表示を切り替える方式を採用した。一度開いたセッションは`openedSessions`セットで追跡し、DOMツリーに残し続ける。

```tsx
{/* 一度でも開いたセッションのみ描画（iframe再マウント防止） */}
{Array.from(sessions.entries())
  .filter(([sessionId]) => openedSessions.has(sessionId))
  .map(([sessionId, session]) => (
    <div
      key={sessionId}
      className={
        activeView === "detail" && selectedSessionId === sessionId
          ? "flex-1 flex flex-col min-h-0"
          : "hidden"
      }
    >
      <MobileSessionView session={session} ... />
    </div>
  ))}
```

### IME対応

日本語入力中にEnterキーを押すと、変換確定ではなくメッセージ送信が発火してしまう問題がある。`compositionStart`/`compositionEnd`イベントでIME入力中を検出し、その間はEnterキーのイベント伝播を停止する。

```typescript
const onKeyDown = usePersistFn((e: React.KeyboardEvent<T>) => {
  // IME入力中はEscとEnterの伝播を阻止
  if (c.current && (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) {
    e.stopPropagation();
    return;
  }
  originalOnKeyDown?.(e);
});
```

Safariでは`compositionEnd`が`onKeyDown`より先に発火するという仕様があるため、二重の`setTimeout`でフラグのリセットを遅延させている。ブラウザごとのIME挙動の差異は、Webフロントエンド開発で最も厄介な領域の一つである。

## モバイルからAIに指示を出したい

### 問題: ターミナル転送の限界

前セクションで述べたモバイル対応は、Quick Keysバーやスワイプスクロールなど数々の工夫を重ねた結果、「iPhoneからClaude Codeを操作できる」レベルには到達した。しかし、使い込むほどに根本的な限界が見えてくる。

iPhoneのソフトウェアキーボードでターミナルコマンドを打つのは、どう工夫しても辛い。外出先でやりたいのは「全セッションの進捗を確認する」「新しいタスクに着手させる」「PR URLを取得する」といった高レベルの操作であって、ターミナル上でキーを叩くことそのものではない。

ここで、開発初期に見送ったAgent SDKが再び選択肢に上がった。ターミナル転送を捨てるのではなく、「指示を出して結果を受け取る」ためのチャットUIを別レイヤーとして追加する方針である。

### 解決策: Beacon — Agent SDKベースのチャットUI

「Beacon（ビーコン）」と名付けたチャット機能を実装した。Agent SDKの`query()` APIを使ったマルチターン会話で、MCPツール経由でCCMの全操作を自動化する。モバイルではタブ切り替え、PCではモーダルダイアログとして、既存のttyd iframeとは独立したUIで提供している。

核となるのは、Agent SDKの`query()`にAsyncIterableでユーザーメッセージを供給するMessageQueueパターンである。

```typescript
class MessageQueue {
  private messages: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private _closed = false;

  push(content: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (!this._closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        const msg = await new Promise<SDKUserMessage>(resolve => {
          this.waiting = resolve;
        });
        if (this._closed) break;
        yield msg;
      }
    }
  }
}
```

`query()`はAsyncIterableインターフェースの`prompt`を受け取り、`yield`されるたびに新しいターンが開始される。MessageQueueの`push()`で外部からメッセージを供給すると、待機中のPromiseが解決されてイテレータが次の値をyieldする。これにより、HTTPリクエストのように「送信 → 応答待ち」ではなく、任意のタイミングでメッセージを投入できるpush方式のマルチターン会話が実現できる。

### MCPツールでCCMを操作する

Beaconの真価は、MCPツール経由でCCMの内部操作を呼び出せる点にある。Agent SDKの`createSdkMcpServer()`でMCPサーバーを作成し、`query()`に渡す。

```typescript
const mcpServer = createSdkMcpServer({
  name: "ccm-beacon",
  version: "1.0.0",
  tools: [
    { name: "list_sessions", ... },
    { name: "send_to_session", ... },
    { name: "get_session_output", ... },
    { name: "gh_exec", ... },
    // ... 12種類のツール
  ],
});

const q = query({
  prompt: queue,
  options: {
    systemPrompt: BEACON_SYSTEM_PROMPT,
    allowedTools: [
      "mcp__ccm-beacon__list_sessions",
      "mcp__ccm-beacon__get_session_output",
      // ...
    ],
    mcpServers: { "ccm-beacon": mcpServer },
  },
});
```

これにより「進捗確認」と入力するだけで、Beaconが`list_sessions` → `get_session_output`を連鎖的に呼び出し、全セッションの状態をサマリーして返してくれる。「タスク着手」なら壁打ちからIssue作成、worktree作成、セッション起動までを一気通貫で実行する。

`gh_exec`ツールにはセキュリティ上の配慮が必要だった。任意のghコマンドを実行できてしまうとリポジトリの破壊が可能になるため、ホワイトリスト方式で許可コマンドを制限している。

```typescript
const ALLOWED_GH_COMMANDS = new Set([
  "pr list", "pr view", "pr checks", "pr diff", "pr status",
  "issue list", "issue view", "issue status",
  "search prs", "search issues",
  "run list", "run view",
  // ...
]);

// -R/--repo フラグも拒否（cwdで対象リポジトリを指定させる）
if (args.includes("-R") || args.includes("--repo")) {
  return { content: [{ type: "text", text: "--repo/-R フラグは許可されていません" }] };
}
if (!ALLOWED_GH_COMMANDS.has(commandKey)) {
  return { content: [{ type: "text", text: `許可されていないコマンドです` }] };
}
```

`--repo`フラグを拒否しているのは、他のリポジトリに対する意図しない操作を防ぐためである。対象リポジトリは`cwd`パラメータで指定させることで、worktreeの物理パスに紐づいた操作に限定している。

### ストリーミング対応

Agent SDKの`query()`はAsyncIterableで出力メッセージを返す。`outputIterator.next()`で逐次読み取り、テキストブロックをSocket.IO経由でクライアントにストリーミングする。

```typescript
while (true) {
  const { value, done } = await session.outputIterator.next();
  if (done) break;
  const msg = value as SDKMessage;

  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        assistantText = appendWithNewline(assistantText, block.text);
        this.emit("beacon:stream", { chunk: block.text, done: false });
      }
    }
  }

  if (msg.type === "result") {
    // resultのテキストがassistantTextに含まれていない場合のみ追加（重複排除）
    if (msg.result && !assistantText.includes(msg.result)) {
      assistantText = appendWithNewline(assistantText, msg.result);
      this.emit("beacon:stream", { chunk: msg.result, done: false });
    }
    this.emit("beacon:stream", { chunk: "", done: true });
    break;
  }
}
```

ここで2つのハマりどころがあった。

1つ目は**テキストブロック間の改行補完**である。ツール実行を挟むと、前後のテキストブロックが直結されてMarkdownの行頭パターンが壊れることがある。`appendWithNewline()`で末尾と先頭の改行を検査し、不足していれば補完する。

```typescript
const appendWithNewline = (base: string, chunk: string): string => {
  if (base && !base.endsWith("\n") && !chunk.startsWith("\n")) {
    return base + "\n" + chunk;
  }
  return base + chunk;
};
```

2つ目は**resultメッセージの重複排除**である。Agent SDKは`assistant`メッセージで返したテキストを`result`メッセージにも含めることがある。`assistantText.includes(msg.result)`でチェックし、既出のテキストは二重送信しないようにしている。

### 技術的なハマりどころ

**processOutput()の重複呼び出し防止**

`sendMessage()`は非同期で`processOutput()`を呼び出すが、ストリーミング中に次のメッセージが来た場合、`processOutput()`が二重に走るとイテレータの状態が壊れる。`session.processing`フラグで排他制御している。

```typescript
private async processOutput(): Promise<void> {
  const session = this.session;
  if (!session) return;
  // 既に処理中の場合はスキップ（重複呼び出し防止）
  if (session.processing) return;
  session.processing = true;
  try {
    // ... ストリーミング処理
  } finally {
    session.processing = false;
  }
}
```

新しいメッセージがキューにpushされると、`query()`内部でツール実行後の次のターンが自動的に走るため、`processOutput()`のwhileループが継続して次の出力を読み取れる。明示的に再呼び出しする必要がない設計になっている。

**アイドルタイムアウトによるリソース解放**

Beaconセッションは`query()`のプロセスを保持するため、放置するとリソースが無駄に消費される。30分間操作がなければ`AbortController.abort()`でquery()を中断し、セッションを閉じる。

```typescript
private cleanupIdleSession(): void {
  if (!this.session) return;
  const idleMs = Date.now() - this.session.lastActivity.getTime();
  if (idleMs > IDLE_TIMEOUT_MS) {
    this.closeSession(); // abortController.abort() + queue.close()
  }
}
```

5分間隔のインターバルタイマーでアイドル時間をチェックし、次にユーザーがメッセージを送信すると新しいセッションが自動的に開始される。会話履歴はセッションごとにリセットされるが、MCPツール経由でCCMの最新状態を都度取得するため、コンテキストの断絶は実用上問題にならない。

## おわりに

Claude Code Managerの技術的な構成を振り返ると、個々の技術はtmux・ttyd・Cloudflare Tunnel・Socket.IOといった枯れたものばかりである。しかし、それらを組み合わせて「iPhoneからClaude Codeを操作する」という体験を実現するには、WebSocket転送の取り回し、モバイルブラウザのビューポート制御、IMEのイベントハンドリングなど、地味だが避けて通れない課題が数多くあった。

そしてBeacon機能の実装で、開発初期に見送ったAgent SDKが別の形で復活した。ターミナル転送を置き換えるのではなく、チャットUIとして横に並べるハイブリッド構成である。PCではttydのフルターミナルでClaude Codeの出力を確認しつつ、iPhoneからはBeaconで「進捗確認」「タスク着手」と指示を出す。ターミナル操作とチャット操作、それぞれが得意な場面で使い分ける形に落ち着いた。

外出先でiPhoneからClaude Codeに指示を出し、帰宅したらPCで続きを確認する。そんなワークフローが日常になりつつある。
