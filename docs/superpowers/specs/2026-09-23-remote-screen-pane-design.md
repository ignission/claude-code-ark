# リモート画面 (別 VM の画面共有を Ark で見る)

- 日付: 2026-09-23
- 検討の経緯: 「別の VM を立ち上げたので、その画面共有を Ark で見たい」という要望。
  対象はビルド用の macOS VM で、ホスト Mac の画面共有アプリで触っていたものを Ark の中に持ち込む
- 検証の方針: 設計を出す前に scratchpad で接続の spike を行い、noVNC 最新版 + SSH 経由で
  macOS 26 の画面共有 (ARD 認証) に繋がることを headless Chromium の描画まで確認した
- 状態: 実装する (ユーザー決定)。置き場所は既存の「ブラウザ」と同じ導線 (ユーザー決定)

## 1. 目的

Ark を離れずに、別 VM のデスクトップを見て操作できるようにする。Ark の「見える / 呼ばれる /
離れられる / 戻れる」の「見える」を、Claude のセッションだけでなく隣の VM にも広げる。

## 2. 決定事項

| 項目 | 決定 |
|---|---|
| 対象 | VNC (RFB) で画面を出す任意のホスト。第一の対象は macOS の画面共有 (Apple ARD 認証、RFB 3.889) |
| 到達経路 | Ark サーバから SSH で届くホストの、その内側の VNC ポート。VM 同士は直接通信できず SSH だけが届く構成を前提にする |
| 画面の描画 | `@novnc/novnc` 1.7 系を web に同梱し、`RFB` を React 部品から直接使う。システムの `/usr/share/novnc` (1.3.0) は ARD 認証を持たないので使わない |
| ブリッジ | Ark サーバ内で WebSocket ↔ `ssh -W <vncHost>:<vncPort>` の stdio を直結する。websockify は使わず、ローカルポートも掴まない |
| 認証 | VNC のユーザー名 + パスワード (ARD) を noVNC の `credentials` で渡す。VM 側の設定は変えない (legacy VNC 認証は有効化しない) |
| 設定の保存 | SQLite (`data/sessions.db`) の `screens` テーブル。パスワードも保存する (ユーザー決定。単一ユーザー前提・data/ は gitignore 済み) |
| 設定の UI | プロファイル管理と同型の「画面の管理」ダイアログ |
| 置き場所 | サイドバーに登録済みの画面を並べ、選ぶと main 領域に全面表示する (既存の「ブラウザ」と同じ)。remote 限定にはしない |
| 対象端末 | PC とモバイルの両方。モバイルは同じ部品を全画面で出す |
| 秘密の扱い | VM のアドレス・ユーザー名・パスワードはリポジトリ・仕様書・ボード・メモリのどこにも書かない |

## 3. 検討して採らなかったもの

### 既存ブラウザと同じ組 (システム noVNC + websockify + `ssh -L`)

apt の noVNC 1.3.0 は Apple ARD 認証 (security type 30) を実装していない。対象の画面共有は
30 / 33 / 35 / 36 しか提示せず、標準 VNC 認証 (type 2) が無いので、この組では繋がらない
(2026-09-23 に RFB 握手で確認)。

VM 側で legacy VNC 認証を有効化すれば通る可能性はあるが、macOS 26 でまだ type 2 が出るかは
未確認で、DES 8 文字の弱い認証を VM に足すことにもなる。ローカルポートも 2 つ増える。

### リポジトリ単位の右ペインタブ

VM はある 1 つのリポジトリのビルド用なので、そのリポのセッションの右ペイン (図解の隣) に
出す案もあった。ユーザーはセッションと独立した「ブラウザ」と同じ導線を選んだ。
セッションを開いていなくても画面だけ見られる方が、用途 (ビルドの様子を見る、Xcode を触る) に合う。

### パスワードを保存せず毎回入力する

開くたびに 1 手間増える。Ark は単一ユーザーのツールで、認証はアプリ全体の 1 関門なので、
プロファイルの `configDir` と同じ扱いで DB に置く (ユーザー決定)。

### 設定ファイルを手で書く

ダイアログを作らない分だけ軽いが、プロファイルと流儀が揃わない。

## 4. 構成

```text
[ブラウザ]  ScreenPane (noVNC RFB)
     │ ws://<ark>/screen/<id>/ws?token=...
     ▼
[Ark サーバ] upgrade handler ── authorizeWebSocketUpgrade ──▶ ScreenBridge
                                                              │ spawn ssh -W vncHost:vncPort
                                                              ▼
[SSH ホスト] sshd ─── TCP ───▶ vncHost:vncPort (画面共有)
```

### 4.1 データ

`screens` テーブル (`database.ts`):

| 列 | 型 | 内容 |
|---|---|---|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | 表示名 |
| ssh_host | TEXT | SSH で届くホスト |
| ssh_port | INTEGER | 既定 22 |
| ssh_user | TEXT | SSH ユーザー |
| vnc_host | TEXT | SSH ホストから見た VNC ホスト。既定 `127.0.0.1` |
| vnc_port | INTEGER | 既定 5900 |
| vnc_user | TEXT | ARD 認証のユーザー名。標準 VNC 認証のホストでは空 |
| vnc_password | TEXT | パスワード |
| created_at / updated_at | INTEGER | epoch ms |

共有型 `Screen` (`@ark/shared`) は `vncPassword` を**含めない**。一覧・作成・更新の応答で
パスワードを配らないため。

### 4.2 Socket.IO イベント

| 方向 | イベント | データ |
|---|---|---|
| C→S | `screen:list` | - |
| C→S | `screen:create` | `{ name, sshHost, sshPort, sshUser, vncHost, vncPort, vncUser, vncPassword }` |
| C→S | `screen:update` | `{ id, ...部分更新 }`。`vncPassword` は指定したときだけ更新 |
| C→S | `screen:delete` | `{ id }` |
| C→S | `screen:credentials` | `id, callback({ username, password })`。接続の直前に 1 回だけ取り、メモリに持つ |
| S→C | `screen:list` | `Screen[]` |
| S→C | `screen:created` / `screen:updated` | `Screen` |
| S→C | `screen:deleted` | `{ id }` |
| S→C | `screen:error` | `{ message, code? }` |

### 4.3 ブリッジ (`screen-bridge.ts`)

- `index.ts` の upgrade handler に `/screen/:id/ws` を追加する。ttyd / browser と同じく
  `authorizeWebSocketUpgrade` を通してから `ws` の `WebSocketServer.handleUpgrade` に渡す
- 接続ごとに `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p <sshPort> -W <vncHost>:<vncPort> <sshUser>@<sshHost>` を spawn し、
  `ws.on("message")` → `ssh.stdin`、`ssh.stdout` → `ws.send` で直結する。
  WebSocket はバイナリ (`binaryType = "arraybuffer"`)。noVNC の `RFB` に渡す URL は `ws(s)://<ark>/screen/<id>/ws`
- WebSocket が閉じたら ssh を SIGTERM し、3 秒で SIGKILL。ssh が終わったら WebSocket を閉じる
- ssh が非 0 で終わったときは stderr の最後の 1 行を `close` の reason (最大 123 バイト) に載せる。
  クライアントはこれを画面に出す (鍵の拒否 / 到達不能 / ポート閉塞を利用者が見分けられるように)
- ssh の鍵はサーバプロセスのユーザーのもの。パスフレーズ付きの鍵は対象外 (BatchMode)
- サーバ終了 (`cleanup()`) で残っている ssh をすべて止める。ttyd と違い再起動後に復元するものは無い

### 4.4 クライアント

- `ScreenPane` (`packages/web/src/components/ScreenPane.tsx`): `@novnc/novnc/core/rfb` の
  `RFB` を `useEffect` で生成し、`scaleViewport = true` で領域にフィットさせる。
  `screen:credentials` で取った値を `credentials` に渡す
- 状態: `connecting` / `connected` / `disconnected(reason)`。切断時は理由と再接続ボタンを出す。
  自動再接続はしない (ブラウザと同じく、ユーザーが押す)
- Dashboard: `selectedSessionId` に `"screen:<id>"` を持たせ、ブラウザと同じく一度開いた画面は
  `display:none` で切り替えて再マウント (再接続) を防ぐ
- サイドバー: 「ブラウザを開く」の隣に登録済みの画面を並べる。設定ダイアログは
  `SessionHeaderMenu` / 設定メニューから開く (プロファイル管理と同じ入口)
- モバイル: `MobileLayout` にも同じ `ScreenPane` を全画面で出す。タッチ操作は noVNC の既定に任せる
- キーボード: noVNC の既定 (フォーカスがあるときキー入力を送る)。Cmd キーは Meta として届く

### 4.5 エラー

| 状況 | 見え方 |
|---|---|
| ssh が繋がらない (到達不能 / 鍵拒否) | 接続直後に切断され、stderr の 1 行が表示される |
| VNC の認証失敗 | noVNC の `securityfailure` を捕まえて「認証に失敗しました」+ 設定ダイアログへの導線 |
| 接続中に ssh が落ちる | `disconnected` に落ち、再接続ボタン |
| 画面が未登録 | サイドバーに何も出ない。設定ダイアログの「追加」だけ |

## 5. テスト

- `screen-bridge.test.ts`: `ssh` を偽の実行ファイル (stdin をそのまま stdout に返す / 非 0 で終わる) に
  差し替え、WebSocket との双方向の疎通、close 時のプロセス終了、失敗理由の伝搬を見る
- `database.test.ts`: `screens` の CRUD と、`Screen` 型にパスワードが載らないこと
- `ScreenManagerDialog.test.tsx`: `ProfileManagerDialog.test.tsx` と同型
- 実機: 対象の VM に Ark 経由で繋ぎ、デスクトップの描画・クリック・キー入力・切断からの再接続を確認する

## 6. 範囲外

- クリップボードの同期
- 複数画面の同時表示 (マルチペインへの組み込み)
- 画面のスクリーンショットを Claude セッションに渡す機能
- SSH のパスワード認証・パスフレーズ付き鍵
- 画面共有側の設定変更 (VNC 認証の有効化など)
