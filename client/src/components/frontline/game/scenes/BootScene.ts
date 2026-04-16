// FrontLine BootScene — スプライトテクスチャ登録とローディング画面

import Phaser from "phaser";

import { GAME_HEIGHT, GAME_WIDTH, SPRITE_KEYS } from "../constants";
import type { PixelGrid } from "../sprites/pixel-sprites";
import {
  CROSS_MARKER,
  CROSSHAIR,
  ENEMY_DEAD,
  ENEMY_HIT,
  ENEMY_SHOOT,
  ENEMY_WALK,
  GRENADE_PROJECTILE,
  GUN_GRENADE,
  GUN_HANDGUN,
  GUN_MACHINEGUN,
  GUN_SHOTGUN,
  GUN_SNIPER,
  HELICOPTER,
  HELICOPTER_DAMAGED,
  PARACHUTE_FALL,
  PARACHUTE_LAND,
  PLAYER_DEAD,
  PLAYER_DEFEND,
  PLAYER_HIT,
  PLAYER_IDLE,
  PLAYER_RELOAD,
  PLAYER_SHOOT,
  GRENADE_PROJECTILE,
  GUN_GRENADE,
  GUN_HANDGUN,
  GUN_MACHINEGUN,
  GUN_SHOTGUN,
  GUN_SNIPER,
  renderPixelGrid,
  SANDBAG,
} from "../sprites/pixel-sprites";

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    // ローディングプログレスバー
    const barW = 200;
    const barH = 20;
    const barX = (GAME_WIDTH - barW) / 2;
    const barY = (GAME_HEIGHT - barH) / 2;

    const bgBar = this.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      barW,
      barH,
      0x222222
    );
    bgBar.setStrokeStyle(2, 0x666666);

    const progressBar = this.add.rectangle(
      barX + 2,
      barY + 2,
      0,
      barH - 4,
      0x4a6a4a
    );
    progressBar.setOrigin(0, 0);

    const loadingText = this.add
      .text(GAME_WIDTH / 2, barY - 20, "Loading...", {
        fontSize: "14px",
        color: "#aaaaaa",
        fontFamily: "monospace",
      })
      .setOrigin(0.5, 1);

    this.load.on("progress", (value: number) => {
      progressBar.width = (barW - 4) * value;
    });

    this.load.on("complete", () => {
      bgBar.destroy();
      progressBar.destroy();
      loadingText.destroy();
    });
  }

  create(): void {
    const SCALE = 2;

    // ピクセルスプライト登録
    this.registerTexture(SPRITE_KEYS.player, PLAYER_IDLE, SCALE);
    this.registerTexture(SPRITE_KEYS.playerDefend, PLAYER_DEFEND, SCALE);
    this.registerTexture(SPRITE_KEYS.enemy, ENEMY_WALK, SCALE);
    this.registerTexture(SPRITE_KEYS.heli, HELICOPTER, SCALE);
    this.registerTexture(SPRITE_KEYS.para, PARACHUTE_FALL, SCALE);
    this.registerTexture(SPRITE_KEYS.parachute, PARACHUTE_LAND, SCALE);
    this.registerTexture(SPRITE_KEYS.ground, SANDBAG, SCALE); // 土嚢をground代替に
    this.registerTexture(SPRITE_KEYS.artilleryWarning, CROSS_MARKER, SCALE);

    // 追加スプライト（SPRITE_KEYSにない拡張キー）
    this.registerTexture("player_shoot", PLAYER_SHOOT, SCALE);
    this.registerTexture("player_reload", PLAYER_RELOAD, SCALE);
    this.registerTexture("player_hit", PLAYER_HIT, SCALE);
    this.registerTexture("player_dead", PLAYER_DEAD, SCALE);
    this.registerTexture("enemy_shoot", ENEMY_SHOOT, SCALE);
    this.registerTexture("enemy_hit", ENEMY_HIT, SCALE);
    this.registerTexture("enemy_dead", ENEMY_DEAD, SCALE);
    this.registerTexture("heli_damaged", HELICOPTER_DAMAGED, SCALE);
    this.registerTexture("para_fall", PARACHUTE_FALL, SCALE);
    this.registerTexture("para_land", PARACHUTE_LAND, SCALE);
    this.registerTexture("crosshair", CROSSHAIR, SCALE);
    this.registerTexture("sandbag", SANDBAG, SCALE);
    this.registerTexture("cross", CROSS_MARKER, SCALE);

    // 武器スプライト
    this.registerTexture("gun_handgun", GUN_HANDGUN, SCALE);
    this.registerTexture("gun_machinegun", GUN_MACHINEGUN, SCALE);
    this.registerTexture("gun_shotgun", GUN_SHOTGUN, SCALE);
    this.registerTexture("gun_sniper", GUN_SNIPER, SCALE);
    this.registerTexture("gun_grenade", GUN_GRENADE, SCALE);
    this.registerTexture("grenade_proj", GRENADE_PROJECTILE, SCALE);

    // 弾丸テクスチャ (4x4 黄色)
    this.createSolidTexture(SPRITE_KEYS.bullet, 4, 4, "#ffcc00");

    // 敵弾テクスチャ (4x4 赤橙)
    this.createSolidTexture(SPRITE_KEYS.enemyBullet, 4, 4, "#ff6633");

    // 薬莢テクスチャ (4x8 茶色)
    this.createSolidTexture("shell_casing", 4, 8, "#8a7a3a");

    // マズルフラッシュ (8x8 黄白)
    this.createSolidTexture(SPRITE_KEYS.muzzleFlash, 8, 8, "#ffeeaa");

    // 爆発 (16x16 オレンジ)
    this.createSolidTexture(SPRITE_KEYS.explosion, 16, 16, "#ff8800");

    // 砲撃インパクト (24x24 暗赤)
    this.createSolidTexture(SPRITE_KEYS.artilleryImpact, 24, 24, "#cc4400");

    // 背景用テクスチャ
    this.createSolidTexture(SPRITE_KEYS.sky, 1, 1, "#4a6a8a");
    this.createSolidTexture(SPRITE_KEYS.mountain, 1, 1, "#3a5a3a");
    this.createSolidTexture(SPRITE_KEYS.building, 1, 1, "#5a5a5a");
    this.createSolidTexture(SPRITE_KEYS.tree, 1, 1, "#2a4a2a");

    // TitleSceneへ遷移
    this.scene.start("TitleScene");
  }

  /** PixelGridからテクスチャを登録 */
  private registerTexture(key: string, grid: PixelGrid, scale: number): void {
    const { canvas } = renderPixelGrid(grid, scale);
    this.textures.addCanvas(key, canvas);
  }

  /** 単色矩形テクスチャを生成・登録 */
  private createSolidTexture(
    key: string,
    w: number,
    h: number,
    color: string
  ): void {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    this.textures.addCanvas(key, canvas);
  }
}
