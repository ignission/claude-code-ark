---
paths:
  - "packages/server/src/lib/screen-*.ts"
  - "packages/web/src/components/Screen*.tsx"
  - "packages/web/src/lib/screen-*.ts"
---

# リモート画面

SSHで届くホストのVNC画面 (macOSの画面共有など) を、noVNCで全面に出す。サイドバーの画面メニュー (PC) / 下部タブ「画面」(モバイル) から開く。

- 設定はSQLiteの `screens` に持つ。VNCのパスワードは一覧 (`screen:list`) に載せず、`screen:credentials` で個別に返す
- **WebSocketは、Arkのサーバーの中で `ssh -W` に直結する** (`screen-bridge.ts`)。websockifyもローカルポートも使わないので、後始末は「socketが閉じたら子プロセスを止める」だけで済む
- ARD認証にWebCryptoを使うので、**localhostかHTTPSでだけ繋がる**

## sshの前提

ブリッジは、Arkのサーバーを動かしているユーザーの権限で `ssh -o BatchMode=yes -W` を起動する。`BatchMode=yes` はプロンプトを一切出せないので、次を満たしていないと接続できない。

- **鍵はArkのサーバーの実行ユーザーのもので、パスフレーズ無し** (またはssh-agentに登録済み)。パスフレーズを聞けずに落ちる
- **接続先が `known_hosts` に登録済み。** 初回の接続は `Host key verification failed` で失敗する。先に一度 `ssh <user>@<host>` を手で通しておく
- **pm2で動かすなら、`ssh` がpm2のPATHにある。** 無いと `spawn ssh ENOENT` になる

どの失敗も「画面が切断され、理由の1行が出る」形でしか見えない。繋がらないときは、まずこの3つを疑う。
