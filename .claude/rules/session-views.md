---
paths:
  - "packages/web/src/components/SplitViewPane.tsx"
  - "packages/web/src/components/SplitChatPane.tsx"
  - "packages/web/src/components/TerminalPane.tsx"
  - "packages/web/src/components/MobileSessionView*.tsx"
  - "packages/web/src/components/SidebarMainLayout.tsx"
  - "packages/web/src/pages/Dashboard.tsx"
  - "packages/web/src/index.css"
  - "packages/web/src/lib/split-*.ts"
  - "packages/web/src/lib/ttyd-reconnect.ts"
  - "packages/web/src/lib/reconcile-*.ts"
  - "packages/web/src/lib/mobile-session-view-mode.ts"
  - "packages/web/src/hooks/useTtydReconnect.ts"
  - "packages/web/src/hooks/useSessionJsonl.ts"
  - "packages/server/src/lib/session-orchestrator.ts"
  - "packages/server/src/lib/jsonl-tail-manager.ts"
  - "packages/server/src/lib/ttyd-*.ts"
---

# セッションの画面 (端末、会話、作業エリア)

PCもモバイルも、ttydの生ターミナル (`TerminalPane`) と、JSONLをtailして会話を描く `SplitChatPane` を切り替えて使う。会話の内容の取り方は `CLAUDE.md` の「情報源分離の原則」に従う。

## PCの構成

- `SplitViewPane` は 左 = 端末 / 会話、右 = 作業エリア の2ペイン。左は上部バーの🖥/💬トグルで切り替える (既定は端末)
- 作業エリアは上部バー右端の「パネル」トグルで開閉し、上端のタブ「図 / ファイル / Git」で中身を替える (`DiagramPane` / `FilePane` / `GitPane`)
- 端末と会話のリンクからファイルを開くと、作業エリアが「ファイル」のタブで開く。左ペインのモードは変わらない。図の中のコードリンクはタブを替えず、図の横の「ピーク」(`FilePeek`) で開く
- **幅を持つのは左ペインで、作業エリアは残りを埋める。** 作業エリアに幅を持たせてピークや「Git」の間だけ広げると、そのたびに会話の幅が変わり、文章の折り返しが動く
- 左ペインの選択と幅、作業エリアの開閉とタブ、開いているファイルタブ、ファイルツリーの展開はlocalStorageに永続化する

## PCの見た目は「浮かぶパネル」

- 色のついた壁紙 (`--wallpaper`) の上に、サイドバー、左 (上部バー + 端末 / 会話)、作業エリアの3枚を8pxのすき間で離して置く。区切りの線は引かず、すき間がそのままリサイザになる (`index.css` の `.app-wallpaper` / `.panel` / `.panel-glass` / `bg-well`)
- パネルの中は線ではなく、くぼみ (`--well`) で分ける
- **大きな面に `backdrop-filter` を使わない。** ttydのiframeとCodeMirrorが描き直すたびにぼかしが走る
- 暗い配色では影が見えないので、パネルを壁紙より明るい面にする

## モバイル

`MobileSessionView` の🖥/💬/📐トグルで1画面ずつ切り替える (既定は会話)。

## 両方をマウントしたまま切り替える

左ペインは端末と会話の両方をマウントしたまま `display` で切り替える。ttydはiframe (別のブラウジングコンテキスト) で、アンマウントすると再接続になるため。

その代わり見えていないペインも生きているので、JSONLの購読と、windowレベルのファイルD&Dは、表示中の1枚だけに絞る (`split-view-left-mode.ts`)。

## メッセージ送信

1. クライアントが `session:send` を送り、pending bubbleを楽観表示する
2. `SessionOrchestrator.sendMessage()` が `tmuxManager.sendKeys()` を呼ぶ
3. tmuxへ `C-u` (入力欄のクリア) → `send-keys -l` のリテラル入力 → `Enter` を送る
4. claudeがJSONLへ追記し、tailがクライアントへ送る。pendingとreconcileして確定の描画にする

## ttydの切断復帰 (Press ⏎ to Reconnect)

ttyd 1.7.4の自動再接続は、socketが落ちたら1度だけ繋ぎ直す。その試行が失敗するとWebSocketのerrorイベントで `doReconnect=false` になり、"Press ⏎ to Reconnect" のまま二度と繋ぎ直さない。モバイルでChromeをバックグラウンドへ送ると、電波が戻る前に再接続を試すのでこの状態に落ちる (実機で確認: close 1006 → tokenのfetch失敗 → connect失敗 → 停止)。

`useTtydReconnect` がiframe内のoverlayを1.5秒ごとに見て、停止を検出したらiframeを貼り直す (判定と抑止は `lib/ttyd-reconnect.ts`)。

- **復帰の手段はiframeのリロード。Enterの合成入力は使わない。** 実は生きている接続にEnterを撃つと、permission promptやAUQを誤って確定させる。リロードならtmuxへ1バイトも送らない
- **`/Reconnect/` で判定しない。** overlayは "Reconnected" / "Reconnecting..." / "80x24" にも使い回されるので、復帰の直後に再リロードする無限ループになる
- **貼り直すのは表示中のペインだけ。** 隠れたiframeを貼り直すと、ttydの `fit()` がサイズ0に対して走り、端末が歪んだままになる
- オフラインの間は貼り直さない (白いiframeが残るだけ)。復帰しないまま3回に達したら諦め、手動のリロードボタンに委ねる
