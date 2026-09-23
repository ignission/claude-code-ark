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
- ssh の終了は `exit` ではなく **`close` イベント**で検知する。`exit` の時点では stdio に
  未配送のデータが残りうるため、stderr の最後の行 (= 失敗理由) が間に合わず
  `ssh exited (255)` に劣化する。二重処理は `exited` フラグで防ぐ
  (SIGTERM / SIGKILL で死んだ子プロセスは `exitCode` が null のままなので、フラグが要る)
- ssh が非 0 で終わったときは stderr の最後の 1 行を `close` の reason (最大 123 バイト) に載せる。
  クライアントはこれを画面に出す (鍵の拒否 / 到達不能 / ポート閉塞を利用者が見分けられるように)
- ssh の鍵はサーバプロセスのユーザーのもの。パスフレーズ付きの鍵は対象外 (BatchMode)。
  前提 (known_hosts、pm2 の PATH) は CLAUDE.md の「リモート画面 (ssh) の前提」に書く
- upgrade handler は `getScreenRecord` から `handleUpgrade` までを try/catch で囲み、
  失敗したら理由をログに残して socket を destroy する。ブリッジに渡すのは
  ssh の宛先 5 項目だけで、パスワードを持つレコードごとは渡さない
- サーバ終了 (`cleanup()`) で残っている ssh をすべて止める。ttyd と違い再起動後に復元するものは無い。
  WebSocket は `close(1001)` ではなく **`terminate()`** で切る。終了経路で close frame の
  往復を待つと、応答しない相手に最大 30 秒ぶら下がる

### 4.4 クライアント

- `ScreenPane` (`packages/web/src/components/ScreenPane.tsx`): `RFB` を **パッケージルート**
  (`@novnc/novnc`) から import する。1.7 の `exports` は `"./core/rfb.js"` という
  ルートだけの指定なので、`@novnc/novnc/core/rfb` という深いパスは解決できない。`useEffect` で生成し、
  `scaleViewport = true` で領域にフィットさせ、`screen:credentials` で取った値を `credentials` に渡す
- 状態: `connecting` / `connected` / `disconnected(reason)`。切断時は理由と再接続ボタンを出す。
  自動再接続はしない (ブラウザと同じく、ユーザーが押す)
- `screen:credentials` の結果はクライアント側で三値に分ける (`ScreenCredentialsResult`)。
  サーバーの ack は `ScreenCredentials | null` のままで、`useSocket` が
  `ok` / `unregistered` (ack が null) / `unavailable` (socket 未接続・ack タイムアウト) に振り分ける。
  「登録し直せ」と「サーバーに繋がらない」は利用者の打ち手が違うので、同じ文言にしない
- Dashboard: `selectedSessionId` に `"screen:<id>"` を持たせ、ブラウザと同じく一度開いた画面は
  マウントしたまま切り替えて再マウント (再接続) を防ぐ。ただし **`display:none` は使わない**。
  noVNC の `scaleViewport` はコンテナの実寸から倍率を決めるので、隠れている間に
  window が resize されると `autoscale(0, 0)` に落ち、戻しても倍率が戻らない。
  絶対配置 + `invisible pointer-events-none` でサイズを保ったまま隠す。
  保険として `ScreenPane` 側でもコンテナを `ResizeObserver` で見て、
  0 → 非 0 に戻ったら `scaleViewport` を入れ直す
- サイドバー: 上部の Monitor アイコンのドロップダウンに登録済みの画面を並べ、同じメニューの
  「画面の管理...」から設定ダイアログを開く (サイドバー本体には並べない)
- モバイル: 下部タブの「画面」から全画面で出す。複数登録があれば上部バーの `<select>` で選ぶ。
  ラッパーは PC と同じ理由でサイズを保ったまま隠す。タッチ操作は noVNC の既定に任せる
- キーボード: noVNC の既定 (フォーカスがあるときキー入力を送る)。Cmd キーは Meta として届く

### 4.5 エラー

| 状況 | 見え方 |
|---|---|
| ssh が繋がらない (到達不能 / 鍵拒否) | 接続直後に切断され、stderr の 1 行が表示される |
| VNC の認証失敗 | noVNC の `securityfailure` を捕まえて「認証に失敗しました」+ 設定ダイアログへの導線 |
| 接続中に ssh が落ちる | `disconnected` に落ち、再接続ボタン |
| 画面が未登録 | サイドバーに何も出ない。設定ダイアログの「追加」だけ |

## 5. テスト

- `screen-bridge.test.ts`: `.claude/rules/backend-testing.md` に従い `node:child_process` を
  `vi.mock` で差し替える (偽の実行ファイルは置かない)。stdin をそのまま stdout に返す偽の子プロセスで、
  WebSocket との双方向の疎通、close 時のプロセス終了と SIGKILL へのエスカレーション、
  失敗理由の伝搬、`closeAll` の `terminate` を見る。
  **実際の spawn と stdio を通る経路はユニットテストでは踏まない**ので、そこは実機の E2E でだけ確かめる
- `screen-input.test.ts`: 入力検証と、`describeScreenDbError` が `screens.name` の UNIQUE 違反だけを
  日本語 + `duplicate_name` に訳すこと
- `database.test.ts`: `screens` の CRUD と、`Screen` 型にパスワードが載らないこと
- `ScreenPane.test.tsx`: `@novnc/novnc` を偽 RFB に差し替え、credentials の三値それぞれの見え方、
  切断理由の表示、再接続、再マウントしないことを見る
- `ScreenManagerDialog.test.tsx`: `ProfileManagerDialog.test.tsx` と同型
- `Dashboard.test.tsx`: 一度開いた画面が選択を移しても再マウントされないこと、
  隠すときに `invisible` を使い `hidden` を使わないこと
- 実機: 対象の VM に Ark 経由で繋ぎ、デスクトップの描画・クリック・キー入力・切断からの再接続を確認する

## 6. 範囲外

- クリップボードの同期
- 複数画面の同時表示 (マルチペインへの組み込み)
- 画面のスクリーンショットを Claude セッションに渡す機能
- SSH のパスワード認証・パスフレーズ付き鍵
- 画面共有側の設定変更 (VNC 認証の有効化など)
