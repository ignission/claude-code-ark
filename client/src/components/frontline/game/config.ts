// FrontLine Phaser ゲーム設定ファクトリ

import Phaser from "phaser";

import { GAME_HEIGHT, GAME_WIDTH } from "./constants";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";
import { RecordsScene } from "./scenes/RecordsScene";
import { ResultScene } from "./scenes/ResultScene";
import { TitleScene } from "./scenes/TitleScene";

export function createGameConfig(
  parent: HTMLElement
): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    pixelArt: true,
    backgroundColor: "#1a1a2e",
    parent,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 0 },
      },
    },
    scene: [BootScene, TitleScene, GameScene, ResultScene, RecordsScene],
    input: {
      activePointers: 2,
    },
  };
}
