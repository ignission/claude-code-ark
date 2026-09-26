# 会話ビューに作業中の端末末尾を出す (liveTail)

## 背景

対話版 claude は返事の本文を書き終えてから JSONL へまとめて書く。そのため
考えている間の会話ビューには「··· 考えています」しか出ず、進んでいるのか
止まっているのかが見えない。

端末には動くものが出ている。作業中の画面には
`✢ Calculating… (43s · ↓ 3.7k tokens · thought for 4s)` のようなスピナー行があり、
秒数とトークン数が増えていく。

サーバーは状態判定のため、すでに 1 秒ごとに全セッションの可視画面を
`capture-pane` している (`SessionOrchestrator.getAllPreviews`)。
既存の `previewText` はスピナー行 (`✢✻`) を UI 行として除外しているので使えない。

## 原則との境界

「画面テキストのパース全面禁止」が禁じるのは、画面を構造に*解釈*すること。
本機能は AUQ カードの「直前の画面」(`auq-screen-context.ts`) と同じく、
capture-pane 出力を**加工せずそのまま**表示用に渡す。行う加工は ANSI 除去・
末尾空行の除去・行数と文字数の上限だけで、行の中身は判定しない。

## 設計

### サーバー

- `getAllPreviews` の各要素に `liveTail?: string` を足す
- 値を入れるのは `bridgeStatus` が `THINK` / `TOOL` のときだけ。それ以外は省く
- 中身は、取得済みの可視画面 raw から ANSI を落とし、末尾の空行を除いて、
  最後の 12 行 (上限 2,000 文字) を残したもの
- 整形は `buildAuqScreenContext` と同じ方針の関数で行う
  (上限の丸め・コードポイント境界を保った切り出しを共有する)
- 追加の tmux 呼び出しは無い。増える通信量は作業中のセッション 1 つにつき
  1 秒あたり約 1KB

### 共有型

- `session:previews` のペイロード型に `liveTail?: string` を足す

### クライアント

- `useSocket` が `session:previews` から sessionId → liveTail を保持する
  (bridgeStatus と同じ経路)
- `SplitChatPane` の `WorkingIndicator` の真上に、等幅・小さめ・薄い色の枠で
  `liveTail` をそのまま出す。1 秒ごとに差し替え、作業中でなくなると消える
- 表示条件は WorkingIndicator と同じ (`workingIndicatorLabel` が非 null) かつ
  `liveTail` が空でないこと。AUQ 表示中は出さない
- 端末の幅は会話欄より広いことがあるので、`white-space: pre` のまま折り返さず
  横スクロールにする (枠線の文字を崩さない)
- `aria-hidden`。1 秒ごとの更新を読み上げさせない
- 枠を出している間は「考えています」を目に見える形では出さない (枠が動きを見せるので重複する)。
  PC の読み上げ領域 (`role="status"`) は同じ要素のまま `sr-only` にして残す
- PC (`SplitViewPane` 経由) とモバイル (`MobileSessionView` 経由) の両方で出す

### 割り切り

末尾 12 行には入力欄と下部の帯 (`❯` と `⏵⏵ bypass permissions…`) が
約 5 行含まれる。除くには画面の解釈が要るので、除かずにそのまま出す。
スピナー行と直前のツール出力が見える範囲に入ることは実機キャプチャで確かめた。

## テスト

- サーバー: `liveTail` が THINK / TOOL のときだけ入る。行数・文字数の上限と
  末尾空行の除去が効く
- クライアント: 作業中だけ枠が出て、作業が終わる・AUQ が出ると消える
- 実機: 会話ビューで長めの指示を送り、秒数が動いて見えることを確かめる

## 範囲外

- スピナー行の秒数やトークン数を抜き出して整形表示すること (パースになる)
- 作業中以外 (IDLE / AWAITING) の画面表示
