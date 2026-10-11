---
paths:
  - "packages/server/src/lib/tunnel*.ts"
  - "packages/server/src/lib/auth*.ts"
---

# リモートアクセス (Cloudflare Tunnel)

スマートフォンや外のデバイスからArkへ届くための機能。2つのモード (Quick / Named) と死活監視は `tunnel.ts` の冒頭にある。起動のしかたは `README.ja.md` にある。

## 認証の条件

**アプリのトークン認証を求めるのは、Quick Tunnel経由のリクエストだけ。** `auth.ts` は、リクエストの宛先がQuick Tunnelのドメイン (`*.trycloudflare.com`) のときだけトークンを確かめ、それ以外 (localhost、LAN内の直接アクセス、Named Tunnel) はアプリの認証を通さない。接続元のIPは見ていない。

## 単一ユーザーの前提

認証は、アプリ全体に対する単一の関門。**セッション単位の閲覧権限は無い。** 認証を通ったクライアントは、任意のセッションの会話履歴、ライブの端末、キーの送出に届く。

Arkは、1人のユーザーが自分のセッション群を管理する道具で、**複数人で共有する構成 (Named Tunnel + Cloudflare Accessでチームに公開するなど) は想定しない。** 所有者のモデルや、経路ごとの権限判定を足す計画は無い (#296で判断)。

## 参考

- [claude-code-remote](https://github.com/yazinsai/claude-code-remote): 同様のリモートアクセスの実装
