# Ark - デザインアイデア

## 概要

複数のClaude Codeインスタンスを管理するWebUIのデザインスタイルを検討する。

---

<response>
<text>
## アイデア1: Terminal-Inspired Dark Mode（ターミナルインスパイア）

### Design Movement

ハッカー/サイバーパンク美学とモダンなミニマリズムの融合

### Core Principles

- **モノスペースフォントの活用**: コード・ターミナル感を強調
- **ダークベース + アクセントカラー**: 黒/ダークグレー背景にネオングリーンやシアンのアクセント
- **情報密度の最適化**: 開発者が必要な情報を一目で把握できるレイアウト
- **ステータスの視覚化**: プロセス状態をLEDライト風のインジケーターで表現

### Color Philosophy

- **Primary**: #00FF88 (Matrix Green) - 成功、アクティブ状態
- **Secondary**: #00D4FF (Cyan) - 情報、リンク
- **Background**: #0D1117 (GitHub Dark) - 目に優しいダーク
- **Surface**: #161B22 - カード、パネル
- **Danger**: #FF6B6B - エラー、停止

### Layout Paradigm

左サイドバーにWorktree一覧、右メインエリアにチャットパネルを配置。タブ形式で複数セッションを切り替え可能。

### Signature Elements

- ターミナルプロンプト風のチャット入力欄（`>_` プレフィックス）
- パルスアニメーション付きのステータスインジケーター
- コードブロックにシンタックスハイライト

### Interaction Philosophy

キーボードショートカット重視。ホバーで詳細情報をツールチップ表示。

### Animation

- タイピングエフェクト風のメッセージ表示
- ステータス変更時のフェードイン/アウト
- サイドバー展開時のスライドアニメーション

### Typography System

- **Display/Headers**: JetBrains Mono Bold
- **Body**: Inter Regular
- **Code**: JetBrains Mono Regular
  </text>
  <probability>0.08</probability>
  </response>

---

<response>
<text>
## アイデア2: Notion-Style Clean Workspace（クリーンワークスペース）

### Design Movement

ミニマリストプロダクティビティ - Notion, Linear, Raycastからの影響

### Core Principles

- **余白の美学**: 十分なホワイトスペースで視覚的な余裕を確保
- **サブトルなシャドウ**: フラットすぎず、立体感を持たせる
- **コンテンツファースト**: UIは控えめに、コンテンツを主役に
- **一貫したリズム**: 8pxグリッドシステムによる統一感

### Color Philosophy

- **Primary**: #2563EB (Indigo Blue) - アクション、フォーカス
- **Background**: #FAFAFA - 柔らかいオフホワイト
- **Surface**: #FFFFFF - カード、モーダル
- **Text Primary**: #1F2937 - 高コントラストの本文
- **Text Secondary**: #6B7280 - 補足情報
- **Border**: #E5E7EB - 繊細な区切り線

### Layout Paradigm

コマンドパレット（Cmd+K）中心のナビゲーション。左にコンパクトなアイコンサイドバー、中央にWorktree管理、右にリサイズ可能なチャットパネル。

### Signature Elements

- 角丸の柔らかいカードデザイン
- ホバー時の微細なスケールアップ
- ブレッドクラム風のセッションナビゲーション

### Interaction Philosophy

マウスとキーボードの両方に最適化。ドラッグ&ドロップでセッション並び替え。

### Animation

- 60fpsのスムーズなトランジション
- ページ遷移時のフェード+スライド
- ローディング時のスケルトンスクリーン

### Typography System

- **Display**: Inter Bold (32-48px)
- **Headers**: Inter Semibold (18-24px)
- **Body**: Inter Regular (14-16px)
  </text>
  <probability>0.05</probability>
  </response>

---

<response>
<text>
## アイデア3: Glassmorphism Dashboard（グラスモーフィズム）

### Design Movement

iOS/macOS Big Sur以降のグラスモーフィズム + ニューモーフィズムの要素

### Core Principles

- **透明感と奥行き**: ブラー効果で階層構造を表現
- **グラデーションの活用**: 単色ではなく微妙なグラデーションで深みを出す
- **光と影の遊び**: 自然光を模したハイライトとシャドウ
- **有機的な形状**: 完全な直線よりも柔らかいカーブ

### Color Philosophy

- **Primary Gradient**: #6366F1 → #8B5CF6 (Indigo to Violet)
- **Background**: #F0F4F8 (Soft Blue Gray)
- **Glass Surface**: rgba(255, 255, 255, 0.7) + backdrop-blur
- **Accent**: #10B981 (Emerald) - 成功状態
- **Text**: #1E293B - 深いスレートグレー

### Layout Paradigm

フローティングカード形式。背景に抽象的なグラデーションブロブ。中央にメインコンテンツ、オーバーレイでモーダル。

### Signature Elements

- フロストガラス効果のカード
- 背景に動くグラデーションブロブ
- ボタンのグロー効果

### Interaction Philosophy

視覚的フィードバック重視。ホバーでカードが浮き上がる。クリックで波紋エフェクト。

### Animation

- 背景ブロブのゆっくりとした移動
- カードのホバー時の浮遊アニメーション
- 成功/エラー時のパルスエフェクト

### Typography System

- **Display**: SF Pro Display Bold / Inter Bold
- **Headers**: SF Pro Text Semibold / Inter Semibold
- **Body**: SF Pro Text Regular / Inter Regular
  </text>
  <probability>0.07</probability>
  </response>

---

## 選定

**アイデア1: Terminal-Inspired Dark Mode** を採用します。

理由:

- Claude Codeという開発ツールの性質上、ターミナル/コード感のあるデザインが最も親和性が高い
- ダークモードは長時間の作業でも目に優しく、開発者に好まれる
- ステータスインジケーターやモノスペースフォントが、プロセス管理ツールとしての機能性を高める
