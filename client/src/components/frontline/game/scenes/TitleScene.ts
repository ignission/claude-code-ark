// FrontLine TitleScene — タイトル画面

import Phaser from "phaser";

import { GAME_HEIGHT, GAME_WIDTH } from "../constants";

export class TitleScene extends Phaser.Scene {
  constructor() {
    super({ key: "TitleScene" });
  }

  create(): void {
    // タイトル
    this.add
      .text(GAME_WIDTH / 2, 100, "FRONT LINE", {
        fontSize: "32px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    // サブタイトル
    this.add
      .text(GAME_WIDTH / 2, 140, "歩兵ひとりでどこまで行けるのか！？", {
        fontSize: "12px",
        color: "#888888",
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    // 戦闘開始ボタン
    this.createButton(GAME_WIDTH / 2, 220, "戦闘開始", "#44cc44", () => {
      this.scene.start("GameScene");
    });

    // 戦績ボタン
    this.createButton(GAME_WIDTH / 2, 270, "戦績", "#888888", () => {
      this.scene.start("RecordsScene");
    });

    // 操作ヒント
    this.add
      .text(
        GAME_WIDTH / 2,
        GAME_HEIGHT - 20,
        "操作: マウスで照準 / クリックで射撃 / 1-4:武器切替 / R:リロード / Space:防御",
        {
          fontSize: "10px",
          color: "#666666",
          fontFamily: "monospace",
        }
      )
      .setOrigin(0.5);
  }

  private createButton(
    x: number,
    y: number,
    label: string,
    color: string,
    onClick: () => void
  ): void {
    const bg = this.add
      .rectangle(x, y, 160, 36, 0x222222)
      .setStrokeStyle(1, 0x444444)
      .setInteractive({ useHandCursor: true });

    this.add
      .text(x, y, label, {
        fontSize: "16px",
        color,
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    bg.on("pointerover", () => bg.setFillStyle(0x333333));
    bg.on("pointerout", () => bg.setFillStyle(0x222222));
    bg.on("pointerdown", onClick);
  }
}
