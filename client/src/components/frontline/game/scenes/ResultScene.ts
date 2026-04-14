// FrontLine ResultScene — 戦果表示画面

import Phaser from "phaser";

import { COMMANDER_COMMENTS, GAME_HEIGHT, GAME_WIDTH } from "../constants";
import type { GameResultData } from "./GameScene";

export class ResultScene extends Phaser.Scene {
  constructor() {
    super({ key: "ResultScene" });
  }

  create(data: GameResultData): void {
    // レコード保存イベント発火（Reactラッパーが受け取ってSocket.IOへ転送）
    this.game.events.emit("frontline:save_record", {
      distance: data.distance,
      kills: data.kills,
      headshots: data.headshots,
      totalShots: data.totalShots,
      playTime: data.playTime,
      meritPoints: data.meritPoints,
      blocks: data.blocks,
      heliKills: data.heliKills,
    });

    // 背景
    this.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      GAME_WIDTH,
      GAME_HEIGHT,
      0x111122,
      0.95
    );

    // タイトル
    this.add
      .text(GAME_WIDTH / 2, 30, "今回の戦果", {
        fontSize: "22px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    // 戦果データ
    const min = Math.floor(data.playTime / 60);
    const sec = data.playTime % 60;
    const timeStr = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;

    const lines = [
      `進軍距離: ${data.distance}m`,
      `撃破数: ${data.kills}`,
      `ヘッドショット: ${data.headshots}`,
      `戦闘時間: ${timeStr}`,
      `功績ポイント: ${data.meritPoints}`,
    ];

    let y = 70;
    for (const line of lines) {
      this.add
        .text(GAME_WIDTH / 2, y, line, {
          fontSize: "14px",
          color: "#cccccc",
          fontFamily: "monospace",
        })
        .setOrigin(0.5);
      y += 24;
    }

    // 司令官コメント
    const category = this.getCommentCategory(data.meritPoints);
    const comments = COMMANDER_COMMENTS[category];
    const comment = comments[Math.floor(Math.random() * comments.length)];

    this.add
      .text(GAME_WIDTH / 2, y + 16, "― 司令官 ―", {
        fontSize: "10px",
        color: "#888888",
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    this.add
      .text(GAME_WIDTH / 2, y + 36, `「${comment}」`, {
        fontSize: "12px",
        color: "#aaccaa",
        fontFamily: "monospace",
        wordWrap: { width: GAME_WIDTH - 60 },
        align: "center",
      })
      .setOrigin(0.5);

    // ボタン
    this.createButton(
      GAME_WIDTH / 2 - 90,
      GAME_HEIGHT - 50,
      "再挑戦",
      "#44cc44",
      () => {
        this.scene.start("GameScene");
      }
    );

    this.createButton(
      GAME_WIDTH / 2 + 90,
      GAME_HEIGHT - 50,
      "タイトルへ",
      "#888888",
      () => {
        this.scene.start("TitleScene");
      }
    );
  }

  private getCommentCategory(
    meritPoints: number
  ): "excellent" | "good" | "average" | "poor" {
    if (meritPoints >= 5000) return "excellent";
    if (meritPoints >= 2000) return "good";
    if (meritPoints >= 500) return "average";
    return "poor";
  }

  private createButton(
    x: number,
    y: number,
    label: string,
    color: string,
    onClick: () => void
  ): void {
    const bg = this.add
      .rectangle(x, y, 140, 32, 0x222222)
      .setStrokeStyle(1, 0x444444)
      .setInteractive({ useHandCursor: true });

    this.add
      .text(x, y, label, {
        fontSize: "14px",
        color,
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    bg.on("pointerover", () => bg.setFillStyle(0x333333));
    bg.on("pointerout", () => bg.setFillStyle(0x222222));
    bg.on("pointerdown", onClick);
  }
}
