// FrontLine RecordsScene — 戦績表示画面

import Phaser from "phaser";
import type { FrontlineStats } from "../../../../../../shared/types";
import { GAME_HEIGHT, GAME_WIDTH, MEDALS } from "../constants";

export class RecordsScene extends Phaser.Scene {
  private onStatsReceived?: (stats: FrontlineStats) => void;
  private onFrontlineError?: (payload: {
    action: "get_stats" | "get_records" | "save_record";
    message: string;
  }) => void;

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

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.onStatsReceived) {
        this.game.events.off("frontline:stats_received", this.onStatsReceived);
      }
      if (this.onFrontlineError) {
        this.game.events.off("frontline:error_received", this.onFrontlineError);
      }
    });

    // 統計取得リクエスト
    this.game.events.emit("frontline:get_stats");

    // 統計受信
    this.onStatsReceived = (stats: FrontlineStats) => {
      loadingText.destroy();
      this.showStats(stats);
    };
    this.game.events.once("frontline:stats_received", this.onStatsReceived);

    this.onFrontlineError = payload => {
      if (payload.action !== "get_stats") return;
      loadingText.setText(`読込失敗: ${payload.message}`);
      loadingText.setColor("#ff7b7b");
    };
    this.game.events.on("frontline:error_received", this.onFrontlineError);

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
    const totalHours = Math.floor(stats.totalPlayTime / 3600);
    const totalMinutes = Math.floor((stats.totalPlayTime % 3600) / 60);
    const accuracy =
      stats.totalShots > 0
        ? Math.round((stats.totalHeadshots / stats.totalShots) * 100)
        : 0;
    const summaryLines = [
      `最長進軍距離  ${stats.bestDistance}m`,
      `最多撃破数    ${stats.bestKills}`,
      `総出撃回数    ${stats.totalPlays}`,
      `階級          ${stats.rank}`,
      `累計功績点    ${stats.totalMeritPoints}`,
      `総戦闘時間    ${totalHours}h ${totalMinutes}m`,
      `命中精度      ${accuracy}% (${stats.totalHeadshots}/${stats.totalShots})`,
    ];

    let y = 72;
    for (const line of summaryLines) {
      this.add
        .text(34, y, line, {
          fontSize: "12px",
          color: "#cccccc",
          fontFamily: "monospace",
        })
        .setOrigin(0, 0);
      y += 20;
    }

    this.renderMedals(stats, 348, 72);
    this.renderPlayHourChart(stats, 34, 236);
    this.renderDeathPositions(stats, 360, 252);
  }

  private renderMedals(stats: FrontlineStats, x: number, y: number): void {
    this.add
      .text(x, y, "勲章一覧", {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0, 0);

    let offsetY = y + 22;
    for (const medal of MEDALS) {
      const obtained = stats.medals.includes(medal.id);
      this.add
        .text(x, offsetY, `${obtained ? "[x]" : "[ ]"} ${medal.name}`, {
          fontSize: "11px",
          color: obtained ? "#ffd166" : "#667788",
          fontFamily: "monospace",
        })
        .setOrigin(0, 0);
      offsetY += 18;
    }
  }

  private renderPlayHourChart(
    stats: FrontlineStats,
    x: number,
    y: number
  ): void {
    this.add
      .text(x, y - 20, "出撃時間帯", {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0, 0);

    const hours = Array.from(
      { length: 24 },
      (_, hour) => stats.playHours[String(hour)] ?? 0
    );
    const maxCount = Math.max(1, ...hours);

    for (let hour = 0; hour < 24; hour++) {
      const count = hours[hour];
      const barHeight = Math.round((count / maxCount) * 52);
      const barX = x + hour * 11;
      this.add
        .rectangle(barX, y + 56 - barHeight / 2, 7, barHeight, 0x6ea8d9, 0.85)
        .setOrigin(0, 0.5);

      if (hour < 10) {
        this.add
          .text(barX, y + 64, String(hour), {
            fontSize: "8px",
            color: "#8899aa",
            fontFamily: "monospace",
          })
          .setOrigin(0, 0);
      }
    }
  }

  private renderDeathPositions(
    stats: FrontlineStats,
    x: number,
    y: number
  ): void {
    this.add
      .text(x, y - 20, "直近の戦没地点", {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0, 0);

    const positions = stats.deathPositions.slice(-10).reverse();
    if (positions.length === 0) {
      this.add
        .text(x, y + 4, "まだ記録がありません", {
          fontSize: "11px",
          color: "#667788",
          fontFamily: "monospace",
        })
        .setOrigin(0, 0);
      return;
    }

    positions.forEach((distance, index) => {
      this.add
        .text(x, y + index * 16, `${index + 1}. ${distance}m`, {
          fontSize: "11px",
          color: "#cccccc",
          fontFamily: "monospace",
        })
        .setOrigin(0, 0);
    });
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
