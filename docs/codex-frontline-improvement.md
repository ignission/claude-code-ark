# FrontLine ゲーム改善タスク — Codex用プロンプト

## プロジェクト概要

`/frontline` ルートに実装されたPhaser.jsベースの横スクロールシューティングゲーム。
元ネタ: https://mclover.hateblo.jp/FrontLine (D.IKUSHIMA氏の2003年作品)

## 技術スタック
- Phaser 3.90 (Canvas renderer)
- React 19 + TailwindCSS 4 + wouter
- TypeScript, Socket.IO, better-sqlite3
- ピクセルアートはコード内定義（pixel-sprites.ts）

## ファイル構成
```text
client/src/components/frontline/
├── FrontLinePage.tsx         # ルートページ
├── FrontLineGame.tsx         # Phaser↔React↔Socket.IOブリッジ
├── MobileControls.tsx        # モバイル仮想ボタン
└── game/
    ├── config.ts             # Phaser設定
    ├── constants.ts          # 全ゲーム定数（武器/敵/階級/勲章等）
    ├── audio/sound-synth.ts  # Web Audio SE合成
    ├── sprites/pixel-sprites.ts # ピクセルスプライトデータ
    └── scenes/
        ├── BootScene.ts      # テクスチャ生成
        ├── TitleScene.ts     # タイトル画面
        ├── GameScene.ts      # メインゲーム（最大ファイル）
        ├── ResultScene.ts    # リザルト画面
        └── RecordsScene.ts   # 戦績画面
server/lib/
    └── frontline-manager.ts  # サーバーサイド（スコア保存/統計/勲章判定）
shared/types.ts               # FrontlineRecord/Stats型
```

## 現在動作しているもの
- タイトル画面 → ゲーム → リザルトの画面遷移
- プレイヤーの横移動（A/D/矢印）
- マウス照準 + クリック射撃
- 4種武器の切替（1-4キー）、リロード（R）、防御（Space）
- 敵兵士のスポーン・移動・射撃
- 弾丸の手動移動 + 距離ベースの衝突判定（ヒット時に赤フラッシュ + 撃破演出）
- 敵HPバー表示
- HUD（HP/弾薬/武器/距離/キル数/時間）
- マズルフラッシュ・薬莢・雨エフェクト
- SE（射撃音/リロード音/ヘッドショット音等）
- サーバーサイドのスコア保存・統計・勲章判定

## 重要な技術的制約
- **Phaser Arcade PhysicsのGroup.add()後にvelocityがリセットされる問題**があり、弾丸はPhaser Groupではなく`playerBulletList: Image[]`配列で管理し、update()内で`x += vx * dt`で手動移動している。衝突判定も`Math.abs(dx) < 20 && Math.abs(dy) < 30`の距離チェック。今後もこの方式を維持すること。
- 敵は`this.physics.add.image()`で生成後`this.enemies`(Arcade Group)にaddしている。敵のvelocityはGroup add後に設定。
- スプライトはPixelGrid型（2D色配列）でpixel-sprites.tsに定義し、BootSceneでCanvasに描画→`textures.addCanvas()`でPhaserテクスチャ登録。外部画像ファイルは使わない。
- ゲームインスタンスは`window.__FRONTLINE_GAME__`でデバッグアクセス可能。

## 改善タスク（優先度順）

### P0: ゲームプレイの根本改善

1. **進攻システムの実装** — 現在distanceは5キルごとに+10mだが、背景スクロールが伴っていない。キル数に応じて背景（山・地面）が右→左にゆっくりスクロールし、前進している感覚を出す。新しい敵は右端からスポーンし直す。

2. **敵の弾がプレイヤーに当たるようにする** — 敵が射撃（enemyFire）しているが、敵弾のプレイヤーへの被弾判定（update()内の「敵弾 vs プレイヤー」セクション）が正しく動作しているか検証。弾丸も敵兵士と同様に手動移動方式に変更が必要かもしれない（enemyBulletsもPhaser Groupなので同じ問題がある可能性）。

3. **ゲームバランス調整** — 現在敵が画面内にランダムスポーンで即座に射撃してくるため、開始直後から難しすぎる。以下に変更:
   - 最初の数体は画面右端からゆっくり歩いてくる（spawnX = GAME_WIDTH + 20に戻す）
   - スポーン間隔を距離に応じて短くする（序盤3秒→中盤1.5秒→終盤0.8秒）
   - 敵の射撃開始までに1-2秒の猶予

### P1: spec未実装の機能

4. **RecordsScene（戦績画面）の完成** — 現在スタブ状態。Socket.IO経由でfrontline:get_statsを呼び、最高距離/最高キル数/累計プレイ回数/階級/累計功績点/勲章一覧/プレイ時間帯グラフを表示する。

5. **ResultScene（リザルト画面）の改善** — 新記録に「NEW」マーク、獲得勲章表示、「戦績」ボタン追加（→RecordsScene遷移）。frontline:record_savedイベントのレスポンス（newMedals配列）を受け取って表示。

6. **十字架マーカー** — 過去10件の死亡距離（deathPositions）をゲーム画面の地面に十字架として表示。BootSceneでcrossテクスチャは登録済み。

### P2: ビジュアル・演出の強化

7. **パララックス背景スクロール** — 空の雲（最低速）、山（低速）、地面（中速）の多層スクロール。進攻時のみスクロール。

8. **敵の武器タイプごとの色分け** — 現在全敵が同じテクスチャ。ENEMY_TYPESのcolorフィールドでtint色を変える（handgun=緑, machinegun=灰, shotgun=茶, sniper=青紫）。

9. **被弾エフェクト改善** — プレイヤーが被弾したら画面端を赤くフラッシュさせる（ビネット効果）。

10. **弾痕** — 弾が地面に当たったら小さな茶色い点を残す（蓄積する）。

### P3: 追加コンテンツ

11. **ヘリコプター/落下傘/砲撃のテスト** — 距離条件（800m/1000m/1500m）が高すぎて到達困難。テスト用に一時的に条件を下げるか、コンソールから`__FRONTLINE_GAME__.scene.getScene('GameScene').distance = 1500`で距離を設定してテスト。

12. **BGM** — sound-synth.tsにシンプルなループBGMを追加（Web Audio APIで合成）。ミュートボタン。

## コーディングルール
- TypeScript strict mode
- biomeでフォーマット＋リント（`pnpm check`で確認）
- コミットメッセージは日本語（`feat(frontline): ○○`形式）
- Co-Authored-Byは付けない
- テストは`pnpm check && pnpm build`で型チェック+ビルド確認
- ブランチ: `feat/frontline-game`
- 設計spec: `docs/superpowers/specs/2026-04-14-frontline-game-design.md`
