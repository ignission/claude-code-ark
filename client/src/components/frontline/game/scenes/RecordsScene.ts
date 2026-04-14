// FrontLine RecordsScene — 戦績表示画面

import Phaser from "phaser";
import type { FrontlineStats } from "../../../../../../shared/types";
import { GAME_HEIGHT, GAME_WIDTH } from "../constants";

export class RecordsScene extends Phaser.Scene {
  constructor() {
    super({ key: "RecordsScene" });
  }

  create(): void {
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
      .text(GAME_WIDTH / 2, 30, "戦績", {
        fontSize: "22px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    // ローディング表示
    const loadingText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "読込中...", {
        fontSize: "14px",
        color: "#888888",
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    // 統計取得リクエスト
    this.game.events.emit("frontline:get_stats");

    // 統計受信
    this.game.events.once(
      "frontline:stats_received",
      (stats: FrontlineStats) => {
        loadingText.destroy();
        this.showStats(stats);
      }
    );

    // タイトルへ戻るボタン（即表示）
    this.createButton(
      GAME_WIDTH / 2,
      GAME_HEIGHT - 40,
      "タイトルへ",
      "#888888",
      () => {
        this.scene.start("TitleScene");
      }
    );
  }

  private showStats(stats: FrontlineStats): void {
    const lines = [
      `最長進軍距離: ${stats.bestDistance}m`,
      `最多撃破数: ${stats.bestKills}`,
      `総出撃回数: ${stats.totalPlays}`,
      `階級: ${stats.rank}`,
      `累計功績ポイント: ${stats.totalMeritPoints}`,
    ];

    let y = 80;
    for (const line of lines) {
      this.add
        .text(GAME_WIDTH / 2, y, line, {
          fontSize: "14px",
          color: "#cccccc",
          fontFamily: "monospace",
        })
        .setOrigin(0.5);
      y += 28;
    }
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
