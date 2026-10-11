---
paths:
  - "packages/server/src/lib/tunnel*.ts"
  - "packages/server/src/lib/auth*.ts"
  - "packages/server/src/lib/qrcode*.ts"
  - "packages/server/src/cli.ts"
---

# リモートアクセス (Cloudflare Tunnel)

スマートフォンや外のデバイスからArkへ届くための機能。`cloudflared` が要る。起動のしかた (`pnpm start:quick` / `pnpm start:remote` など) は `README.ja.md` にある。

## 2つのモード

- **Quick Tunnel** (`--quick`): トークン認証を有効にして、Quick Tunnelを起動する。URLは一時的な `*.trycloudflare.com` で、ランダムに生成したトークンをURLに含める。ターミナルにQRコードとURLを出す
- **Named Tunnel** (`--remote` + `ARK_PUBLIC_DOMAIN`): 固定のドメインを使い、認証はCloudflare Accessに任せる。死活監視と張り直しの仕様は `tunnel.ts` の冒頭にある
- HTTPSはCloudflare Tunnelが提供する
- **アプリのトークン認証を求めるのは、Quick Tunnel経由のリクエストだけ。** `auth.ts` は、リクエストの宛先がQuick Tunnelのドメイン (`*.trycloudflare.com`) のときだけトークンを確かめ、それ以外 (localhost、LAN内の直接アクセス、Named Tunnel) はアプリの認証を通さない。接続元のIPは見ていない

## 単一ユーザーの前提

認証は、アプリ全体に対する単一の関門。**セッション単位の閲覧権限は無い。** 認証を通ったクライアントは、任意のセッションの会話履歴、ライブの端末、キーの送出に届く。

Arkは、1人のユーザーが自分のセッション群を管理する道具で、**複数人で共有する構成 (Named Tunnel + Cloudflare Accessでチームに公開するなど) は想定しない。** 所有者のモデルや、経路ごとの権限判定を足す計画は無い (#296で判断)。

## 自動復旧

前回トンネルが有効だったなら、サーバーの再起動時に自動で起動し直す。状態は `/tmp/ark-tunnel-state.json` に持つ。

## 参考

- [claude-code-remote](https://github.com/yazinsai/claude-code-remote): 同様のリモートアクセスの実装
