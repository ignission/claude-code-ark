// FrontLine GameScene — メインゲームロジック

import Phaser from "phaser";
import type { FrontlineStats } from "../../../../../../shared/types";

import { SoundSynth } from "../audio/sound-synth";
import {
  ADVANCE_DISTANCE,
  ARTILLERY_DAMAGE,
  ARTILLERY_MIN_DISTANCE,
  ENEMY_TYPES,
  type EnemyTypeDef,
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_Y,
  HEADSHOT_MULTIPLIER,
  HEADSHOT_ZONE,
  HELI_DAMAGE,
  HELI_FIRE_RATE,
  HELI_HP,
  HELI_MIN_DISTANCE,
  HELI_SPEED,
  HUD_HEIGHT,
  KILLS_TO_ADVANCE,
  PARA_FALL_SPEED,
  PARA_HP,
  PARA_MIN_DISTANCE,
  PLAYER_MAX_HP,
  PLAYER_X,
  SPRITE_KEYS,
  WEAPONS,
} from "../constants";

/** GameScene → ResultScene へ渡すデータ */
export interface GameResultData {
  distance: number;
  kills: number;
  headshots: number;
  totalShots: number;
  playTime: number;
  meritPoints: number;
  blocks: number;
  heliKills: number;
}

export class GameScene extends Phaser.Scene {
  private static readonly PIXELS_PER_METER = 0.35;
  private static readonly MAX_BULLET_MARKS = 80;
  private static readonly MOVE_METERS_PER_PIXEL = 0.16;

  // --- 状態 ---
  private playerHp = PLAYER_MAX_HP;
  private distance = 0;
  private kills = 0;
  private headshots = 0;
  private totalShots = 0;
  private blocks = 0;
  private heliKills = 0;
  private playTime = 0;
  private currentWeapon = 0;
  private isDefending = false;
  private isReloading = false;
  private gameOver = false;
  private magAmmo: number[] = [];
  private reserveAmmo: number[] = [];
  private gameTimer = 0;
  private lastFireTime = 0;
  private killsSinceAdvance = 0;
  private pendingAdvanceScroll = 0;
  private reloadStartedAt = 0;
  private reloadDuration = 0;
  private reloadTotalDuration = 0;
  private reloadCompletedDuration = 0;
  private pausedReloadDuration = 0;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyF!: Phaser.Input.Keyboard.Key;

  // --- Phaser オブジェクト ---
  private player!: Phaser.GameObjects.Image;
  private crosshair!: Phaser.GameObjects.Image;
  private enemies!: Phaser.Physics.Arcade.Group;
  private playerBulletList: Phaser.GameObjects.Image[] = [];
  private enemyBulletList: Phaser.GameObjects.Image[] = [];
  private defendShield?: Phaser.GameObjects.Arc;
  private playerHpBarBg?: Phaser.GameObjects.Rectangle;
  private playerHpBarFill?: Phaser.GameObjects.Rectangle;
  private cloudLayer: Phaser.GameObjects.Ellipse[] = [];
  private mountainLayer: Phaser.GameObjects.Triangle[] = [];
  private terrainFill?: Phaser.GameObjects.Graphics;
  private terrainLine?: Phaser.GameObjects.Graphics;
  private crossMarkers: Array<{
    distance: number;
    sprite: Phaser.GameObjects.Image;
  }> = [];
  private bulletMarks: Phaser.GameObjects.Rectangle[] = [];
  private damageOverlay?: Phaser.GameObjects.Rectangle;
  private terrainDisplayShift = 0;

  // --- HUD テキスト ---
  private hpText!: Phaser.GameObjects.Text;
  private ammoText!: Phaser.GameObjects.Text;
  private reloadBarBg?: Phaser.GameObjects.Rectangle;
  private reloadBarFill?: Phaser.GameObjects.Rectangle;
  private weaponTexts: Phaser.GameObjects.Text[] = [];
  private distanceText!: Phaser.GameObjects.Text;
  private killsText!: Phaser.GameObjects.Text;
  private timeText!: Phaser.GameObjects.Text;

  // --- タイマー ---
  private enemySpawnTimer?: Phaser.Time.TimerEvent;
  private heliSpawnTimer?: Phaser.Time.TimerEvent;
  private paraSpawnTimer?: Phaser.Time.TimerEvent;
  private artilleryTimer?: Phaser.Time.TimerEvent;
  private reloadTimer?: Phaser.Time.TimerEvent;
  private rainTimer?: Phaser.Time.TimerEvent;
  private rainGraphics?: Phaser.GameObjects.Graphics;
  private onStatsReceived?: (stats: FrontlineStats) => void;

  constructor() {
    super({ key: "GameScene" });
  }

  create(): void {
    console.log("[GameScene] create() start");
    try {
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
      this.resetState();
      console.log("[GameScene] resetState done");
      this.createBackground();
      console.log("[GameScene] createBackground done");
      this.createPlayer();
      console.log("[GameScene] createPlayer done");
      this.createHUD();
      console.log("[GameScene] createHUD done");
      this.createGroups();
      console.log("[GameScene] createGroups done");
      this.loadDeathMarkers();
      console.log("[GameScene] loadDeathMarkers queued");
      this.setupInput();
      console.log("[GameScene] setupInput done");
      this.setupEnemySpawner();
      console.log("[GameScene] setupEnemySpawner done");

      // モバイル操作イベント
      this.game.events.on("mobile:action", this.handleMobileAction, this);

      // 30%の確率で雨エフェクト
      if (Math.random() < 0.3) {
        this.startRain();
      }
      console.log(
        "[GameScene] create() complete, enemies group size:",
        this.enemies.getLength()
      );
    } catch (e) {
      console.error("[GameScene] create() ERROR:", e);
    }
  }

  /** 雨エフェクト — 斜めの線を描画し続ける */
  private startRain(): void {
    this.rainGraphics?.destroy();
    this.rainTimer?.remove(false);

    this.rainGraphics = this.add.graphics().setDepth(90);
    this.rainTimer = this.time.addEvent({
      delay: 50,
      loop: true,
      callback: () => {
        this.rainGraphics?.clear();
        this.rainGraphics?.lineStyle(1, 0x6688aa, 0.3);
        for (let i = 0; i < 40; i++) {
          const x = Math.random() * GAME_WIDTH;
          const y = Math.random() * GROUND_Y;
          this.rainGraphics?.beginPath();
          this.rainGraphics?.moveTo(x, y);
          this.rainGraphics?.lineTo(x - 4, y + 10);
          this.rainGraphics?.strokePath();
        }
      },
    });
  }

  shutdown(): void {
    this.game.events.off("mobile:action", this.handleMobileAction, this);
    if (this.onStatsReceived) {
      this.game.events.off("frontline:stats_received", this.onStatsReceived);
    }
    this.rainTimer?.remove(false);
    this.rainTimer = undefined;
    this.rainGraphics?.destroy();
    this.rainGraphics = undefined;
    this.input.setDefaultCursor("default");
  }

  // ============================
  // 初期化
  // ============================

  private resetState(): void {
    this.playerHp = PLAYER_MAX_HP;
    this.distance = 0;
    this.kills = 0;
    this.headshots = 0;
    this.totalShots = 0;
    this.blocks = 0;
    this.heliKills = 0;
    this.playTime = 0;
    this.currentWeapon = 0;
    this.isDefending = false;
    this.isReloading = false;
    this.gameOver = false;
    this.gameTimer = 0;
    this.lastFireTime = 0;
    this.killsSinceAdvance = 0;
    this.pendingAdvanceScroll = 0;
    this.reloadStartedAt = 0;
    this.reloadDuration = 0;
    this.reloadTotalDuration = 0;
    this.reloadCompletedDuration = 0;
    this.pausedReloadDuration = 0;

    this.magAmmo = WEAPONS.map(w => w.magSize);
    this.reserveAmmo = WEAPONS.map(w => w.reserveAmmo);
  }

  private createBackground(): void {
    // 空グラデーション
    const skyGfx = this.add.graphics();
    skyGfx.fillGradientStyle(0x1a2a4a, 0x1a2a4a, 0x4a6a8a, 0x4a6a8a, 1);
    skyGfx.fillRect(0, 0, GAME_WIDTH, GROUND_Y);

    for (let i = 0; i < 5; i++) {
      const cloud = this.add
        .ellipse(
          80 + i * 150,
          50 + (i % 2) * 18,
          70 + (i % 3) * 20,
          24 + (i % 2) * 6,
          0xf6f7fb,
          0.2
        )
        .setDepth(4);
      this.cloudLayer.push(cloud);
    }

    for (let i = 0; i < 6; i++) {
      const mountain = this.add
        .triangle(
          i * 140 + 60,
          GROUND_Y - 18,
          0,
          0,
          80,
          -40 - (i % 3) * 18,
          160,
          0,
          0x2a3a2a,
          1
        )
        .setOrigin(0.5, 1)
        .setDepth(2);
      this.mountainLayer.push(mountain);
    }

    // 地面ベース
    this.add.rectangle(
      GAME_WIDTH / 2,
      GROUND_Y + (GAME_HEIGHT - GROUND_Y - HUD_HEIGHT) / 2,
      GAME_WIDTH,
      GAME_HEIGHT - GROUND_Y - HUD_HEIGHT,
      0x5a4a2a
    );

    this.terrainFill = this.add.graphics().setDepth(18);
    this.terrainLine = this.add.graphics().setDepth(19);
    this.redrawTerrain();

    this.damageOverlay = this.add
      .rectangle(
        GAME_WIDTH / 2,
        GAME_HEIGHT / 2,
        GAME_WIDTH,
        GAME_HEIGHT,
        0xaa1111,
        0
      )
      .setDepth(160);

    // HUD背景
    this.add
      .rectangle(
        GAME_WIDTH / 2,
        GAME_HEIGHT - HUD_HEIGHT / 2,
        GAME_WIDTH,
        HUD_HEIGHT,
        0x111111,
        0.9
      )
      .setDepth(100);
  }

  private createPlayer(): void {
    const playerGroundY = this.getGroundYAtX(PLAYER_X);
    this.player = this.add
      .image(PLAYER_X, playerGroundY - 24, SPRITE_KEYS.player)
      .setDepth(35);
    this.defendShield = this.add
      .arc(
        PLAYER_X + 10,
        playerGroundY - 24,
        18,
        -70,
        70,
        false,
        0x88b7d8,
        0.35
      )
      .setStrokeStyle(2, 0xd9ecff, 0.8)
      .setDepth(45)
      .setVisible(false);
    this.playerHpBarBg = this.add
      .rectangle(PLAYER_X, playerGroundY - 52, 30, 5, 0x221111, 0.9)
      .setDepth(46);
    this.playerHpBarFill = this.add
      .rectangle(PLAYER_X, playerGroundY - 52, 28, 3, 0x44cc44, 1)
      .setOrigin(0, 0.5)
      .setDepth(47);
    this.crosshair = this.add
      .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "crosshair")
      .setDepth(200);

    this.updatePlayerHpBar();
    this.input.setDefaultCursor("none");
  }

  private createHUD(): void {
    const hudTop = GAME_HEIGHT - HUD_HEIGHT + 8;

    this.hpText = this.add
      .text(8, hudTop, "", {
        fontSize: "12px",
        color: "#44cc44",
        fontFamily: "monospace",
      })
      .setDepth(101);

    this.ammoText = this.add
      .text(8, hudTop + 16, "", {
        fontSize: "12px",
        color: "#ffffff",
        fontFamily: "monospace",
      })
      .setDepth(101);

    this.reloadBarBg = this.add
      .rectangle(8, hudTop + 30, 124, 6, 0x221111, 0.9)
      .setOrigin(0, 0.5)
      .setDepth(101)
      .setVisible(false);
    this.reloadBarFill = this.add
      .rectangle(8, hudTop + 30, 0, 4, 0x66ccff, 1)
      .setOrigin(0, 0.5)
      .setDepth(102)
      .setVisible(false);

    // 武器名テキスト
    this.weaponTexts = [];
    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      const txt = this.add
        .text(8 + i * 90, hudTop + 42, `${w.key}:${w.nameJa}`, {
          fontSize: "10px",
          color: i === 0 ? "#ffcc00" : "#666666",
          fontFamily: "monospace",
        })
        .setDepth(101);
      this.weaponTexts.push(txt);
    }

    this.distanceText = this.add
      .text(GAME_WIDTH - 8, hudTop, "", {
        fontSize: "18px",
        color: "#ffffff",
        fontFamily: "monospace",
      })
      .setOrigin(1, 0)
      .setDepth(101);

    this.killsText = this.add
      .text(GAME_WIDTH - 8, hudTop + 24, "", {
        fontSize: "12px",
        color: "#cccccc",
        fontFamily: "monospace",
      })
      .setOrigin(1, 0)
      .setDepth(101);

    this.timeText = this.add
      .text(GAME_WIDTH - 8, hudTop + 40, "", {
        fontSize: "12px",
        color: "#aaaaaa",
        fontFamily: "monospace",
      })
      .setOrigin(1, 0)
      .setDepth(101);
  }

  private createGroups(): void {
    this.enemies = this.physics.add.group();
    this.playerBulletList = [];
    this.enemyBulletList = [];
    // 衝突判定はupdate()内で手動距離チェック
  }

  private loadDeathMarkers(): void {
    this.onStatsReceived = (stats: FrontlineStats) => {
      this.renderDeathMarkers(stats.deathPositions);
    };
    this.game.events.once("frontline:stats_received", this.onStatsReceived);
    this.game.events.emit("frontline:get_stats");
  }

  private renderDeathMarkers(deathPositions: number[]): void {
    for (const marker of this.crossMarkers) {
      marker.sprite.destroy();
    }

    this.crossMarkers = deathPositions.slice(-10).map(distance => ({
      distance,
      sprite: this.add
        .image(-100, this.getGroundYAtX(-100) - 14, "cross")
        .setDepth(22)
        .setAlpha(0.75)
        .setVisible(false),
    }));
  }

  private updateBackgroundScroll(delta: number): void {
    if (this.pendingAdvanceScroll > 0) {
      const step = Math.min(this.pendingAdvanceScroll, delta * 0.12);
      this.pendingAdvanceScroll -= step;

      this.shiftLoopingLayer(this.cloudLayer, -step * 0.15, 140);
      this.shiftLoopingLayer(this.mountainLayer, -step * 0.4, 170);
      this.scrollTerrain(-step);
      this.updateCrossMarkers(-step);
      return;
    }

    this.updateCrossMarkers();
  }

  private shiftLoopingLayer<
    T extends Phaser.GameObjects.GameObject & {
      x: number;
      displayWidth: number;
    },
  >(objects: T[], amount: number, spacing: number): void {
    if (objects.length === 0 || amount === 0) return;

    let leftmostX = Math.min(...objects.map(object => object.x));
    let rightmostX = Math.max(...objects.map(object => object.x));
    for (const object of objects) {
      object.x += amount;
      if (amount < 0 && object.x < -object.displayWidth) {
        object.x = rightmostX + spacing;
        rightmostX = object.x;
      } else if (amount > 0 && object.x > GAME_WIDTH + object.displayWidth) {
        object.x = leftmostX - spacing;
        leftmostX = object.x;
      } else {
        if (object.x < leftmostX) leftmostX = object.x;
        if (object.x > rightmostX) rightmostX = object.x;
      }
    }
  }

  private updateCrossMarkers(scrollAmount = 0): void {
    const windowDistance = GAME_WIDTH / GameScene.PIXELS_PER_METER;

    for (const marker of this.crossMarkers) {
      const distanceAhead = marker.distance - this.distance;
      const sprite = marker.sprite;

      if (distanceAhead < -40 || distanceAhead > windowDistance) {
        sprite.setVisible(false);
        continue;
      }

      const baseX = GAME_WIDTH - distanceAhead * GameScene.PIXELS_PER_METER;
      sprite.setVisible(true);
      sprite.x = scrollAmount !== 0 ? sprite.x + scrollAmount : baseX;
      sprite.y = this.getGroundYAtX(sprite.x) - 14;

      if (
        scrollAmount !== 0 &&
        (sprite.x < -16 || sprite.x > GAME_WIDTH + 16)
      ) {
        sprite.x = baseX;
      }
    }
  }

  private scrollTerrain(amount: number): void {
    if (amount === 0) return;
    this.terrainDisplayShift += amount;
    this.redrawTerrain();
  }

  private getGroundYAtX(screenX: number): number {
    const worldX = screenX - this.terrainDisplayShift;
    return this.getGroundYAtWorldX(worldX);
  }

  private getGroundYAtWorldX(worldX: number): number {
    const segment = ((worldX % 768) + 768) % 768;
    let terrace = GROUND_Y + 6;

    if (segment < 76) {
      terrace = GROUND_Y + 10;
    } else if (segment < 138) {
      terrace = GROUND_Y - 6;
    } else if (segment < 196) {
      terrace = GROUND_Y - 36;
    } else if (segment < 256) {
      terrace = GROUND_Y - 74;
    } else if (segment < 332) {
      terrace = GROUND_Y - 118;
    } else if (segment < 404) {
      terrace = GROUND_Y - 88;
    } else if (segment < 470) {
      terrace = GROUND_Y - 48;
    } else if (segment < 540) {
      terrace = GROUND_Y - 16;
    } else if (segment < 608) {
      terrace = GROUND_Y + 8;
    } else if (segment < 664) {
      terrace = GROUND_Y - 24;
    } else if (segment < 720) {
      terrace = GROUND_Y - 68;
    } else {
      terrace = GROUND_Y - 18;
    }

    const localRamps = [
      { start: 62, end: 92, from: GROUND_Y + 10, to: GROUND_Y - 6 },
      { start: 130, end: 164, from: GROUND_Y - 6, to: GROUND_Y - 36 },
      { start: 188, end: 224, from: GROUND_Y - 36, to: GROUND_Y - 74 },
      { start: 248, end: 294, from: GROUND_Y - 74, to: GROUND_Y - 118 },
      { start: 390, end: 430, from: GROUND_Y - 88, to: GROUND_Y - 48 },
      { start: 462, end: 496, from: GROUND_Y - 48, to: GROUND_Y - 16 },
      { start: 600, end: 632, from: GROUND_Y + 8, to: GROUND_Y - 24 },
      { start: 656, end: 696, from: GROUND_Y - 24, to: GROUND_Y - 68 },
      { start: 716, end: 752, from: GROUND_Y - 68, to: GROUND_Y - 18 },
    ];

    for (const ramp of localRamps) {
      if (segment >= ramp.start && segment <= ramp.end) {
        const t = (segment - ramp.start) / (ramp.end - ramp.start);
        terrace = Phaser.Math.Linear(ramp.from, ramp.to, t);
        break;
      }
    }

    const trenchPhase = ((worldX % 320) + 320) % 320;
    const trench =
      trenchPhase > 214 && trenchPhase < 256
        ? -14 * (1 - Math.abs(trenchPhase - 235) / 21)
        : 0;
    const minorNoise =
      Math.sin(worldX / 53) * 1.2 + Math.sin((worldX + 18) / 29) * 0.6;

    return Phaser.Math.Clamp(terrace + trench + minorNoise, 198, GROUND_Y + 18);
  }

  private redrawTerrain(): void {
    if (!this.terrainFill || !this.terrainLine) return;

    const topPoints: number[] = [];
    this.terrainFill.clear();
    this.terrainLine.clear();

    for (let x = -16; x <= GAME_WIDTH + 16; x += 4) {
      const y = this.getGroundYAtX(x);
      topPoints.push(x, y);
    }

    this.terrainFill.fillStyle(0x4a341f, 1);
    this.terrainFill.fillPoints(
      [
        new Phaser.Geom.Point(-16, GAME_HEIGHT - HUD_HEIGHT),
        ...this.toGeomPoints(topPoints),
        new Phaser.Geom.Point(GAME_WIDTH + 16, GAME_HEIGHT - HUD_HEIGHT),
      ],
      true
    );

    this.terrainFill.fillStyle(0x6a4a2f, 0.95);
    for (let i = 0; i < topPoints.length - 2; i += 2) {
      const x1 = topPoints[i];
      const y1 = topPoints[i + 1];
      const x2 = topPoints[i + 2];
      const y2 = topPoints[i + 3];
      this.terrainFill.fillTriangle(x1, y1, x2, y2, x2, y2 + 18);

      if (Math.abs(y2 - y1) > 7) {
        this.terrainFill.fillStyle(0x3b2918, 0.85);
        this.terrainFill.fillRect(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.max(4, Math.abs(x2 - x1)),
          Math.abs(y2 - y1)
        );
        this.terrainFill.fillStyle(0x6a4a2f, 0.95);
      }
    }

    this.terrainLine.lineStyle(2, 0xc7aa6e, 0.9);
    this.terrainLine.beginPath();
    this.terrainLine.moveTo(topPoints[0], topPoints[1]);
    for (let i = 2; i < topPoints.length; i += 2) {
      this.terrainLine.lineTo(topPoints[i], topPoints[i + 1]);
    }
    this.terrainLine.strokePath();
  }

  private toGeomPoints(points: number[]): Phaser.Geom.Point[] {
    const result: Phaser.Geom.Point[] = [];
    for (let i = 0; i < points.length; i += 2) {
      result.push(new Phaser.Geom.Point(points[i], points[i + 1]));
    }
    return result;
  }

  private createBulletMark(x: number, y: number, color = 0x3f2c1f): void {
    const mark = this.add
      .rectangle(x, y, 3 + Math.random() * 3, 2 + Math.random() * 2, color, 0.7)
      .setAngle(Math.random() * 180)
      .setDepth(19);
    this.bulletMarks.push(mark);

    if (this.bulletMarks.length > GameScene.MAX_BULLET_MARKS) {
      this.bulletMarks.shift()?.destroy();
    }
  }

  private getEnemyHpBarColor(hpRatio: number): number {
    if (hpRatio > 0.6) return 0x44cc44;
    if (hpRatio > 0.3) return 0xcccc44;
    return 0xcc4444;
  }

  private getGroundCollisionPoint(
    prevX: number,
    prevY: number,
    nextX: number,
    nextY: number
  ): { x: number; y: number } | null {
    const distance = Math.max(Math.abs(nextX - prevX), Math.abs(nextY - prevY));
    const steps = Math.max(1, Math.ceil(distance / 4));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Phaser.Math.Linear(prevX, nextX, t);
      const y = Phaser.Math.Linear(prevY, nextY, t);
      const groundY = this.getGroundYAtX(x) - 4;
      if (y >= groundY) {
        return { x, y: groundY };
      }
    }

    return null;
  }

  // ============================
  // 入力
  // ============================

  private setupInput(): void {
    // 照準追従
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.crosshair.setPosition(pointer.worldX, pointer.worldY);
    });

    // 射撃
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.worldY > GAME_HEIGHT - HUD_HEIGHT) return;
      if (this.isDefending || this.isReloading || this.gameOver) return;
      this.fire(pointer.worldX, pointer.worldY);
    });

    // キーボード
    const keyboard = this.input.keyboard;
    if (!keyboard) return;

    // 移動キー（矢印 + A/D）
    this.cursors = keyboard.createCursorKeys();
    this.keyA = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyF = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);

    keyboard.on("keydown-ONE", () => this.switchWeapon(0));
    keyboard.on("keydown-TWO", () => this.switchWeapon(1));
    keyboard.on("keydown-THREE", () => this.switchWeapon(2));
    keyboard.on("keydown-FOUR", () => this.switchWeapon(3));
    keyboard.on("keydown-R", () => this.reload());
    keyboard.on("keydown-SPACE", () => this.startDefend());
    keyboard.on("keyup-SPACE", () => this.stopDefend());
    keyboard.on("keydown-TAB", (e: KeyboardEvent) => {
      e.preventDefault();
      if (this.scene.isPaused()) {
        this.scene.resume();
      } else {
        this.scene.pause();
      }
    });
  }

  private handleMobileAction = (detail: {
    action: string;
    value?: number;
  }): void => {
    if (this.gameOver) return;
    switch (detail.action) {
      case "fire":
        this.fire(this.crosshair.x, this.crosshair.y);
        break;
      case "reload":
        this.reload();
        break;
      case "defend":
        this.startDefend();
        break;
      case "defendEnd":
        this.stopDefend();
        break;
      case "weapon":
        if (detail.value != null) this.switchWeapon(detail.value - 1);
        break;
      case "weapon1":
        this.switchWeapon(0);
        break;
      case "weapon2":
        this.switchWeapon(1);
        break;
      case "weapon3":
        this.switchWeapon(2);
        break;
      case "weapon4":
        this.switchWeapon(3);
        break;
    }
  };

  // ============================
  // 射撃
  // ============================

  private fire(targetX: number, targetY: number): void {
    const weapon = WEAPONS[this.currentWeapon];
    const now = this.time.now;

    // 発射レート確認
    if (now - this.lastFireTime < weapon.fireRate) return;

    // 弾倉確認
    if (this.magAmmo[this.currentWeapon] <= 0) {
      this.reload();
      return;
    }

    this.lastFireTime = now;
    this.magAmmo[this.currentWeapon]--;
    this.totalShots++;
    console.log(
      "[FIRE] weapon:",
      weapon.name,
      "target:",
      Math.round(targetX),
      Math.round(targetY),
      "bullets in list:",
      this.playerBulletList.length
    );

    const gunX = this.player.x + 20;
    const gunY = this.player.y;
    const baseAngle = Math.atan2(targetY - gunY, targetX - gunX);

    // 射撃サウンド
    switch (weapon.name) {
      case "Handgun":
        SoundSynth.handgunShot();
        break;
      case "Machinegun":
        SoundSynth.machinegunShot();
        break;
      case "Shotgun":
        SoundSynth.shotgunShot();
        break;
      case "Sniper":
        SoundSynth.sniperShot();
        break;
    }

    // ペレット発射
    for (let p = 0; p < weapon.pellets; p++) {
      const spread = (Math.random() - 0.5) * weapon.spread * 2;
      const angle = baseAngle + spread;
      const vx = Math.cos(angle) * weapon.bulletSpeed;
      const vy = Math.sin(angle) * weapon.bulletSpeed;

      const bullet = this.add
        .image(gunX, gunY, SPRITE_KEYS.bullet)
        .setDepth(50);
      bullet.setData("damage", weapon.damage);
      bullet.setData("vx", vx);
      bullet.setData("vy", vy);
      this.playerBulletList.push(bullet);

      // 2秒後に自動破棄
      this.time.delayedCall(2000, () => {
        if (bullet.active) bullet.destroy();
      });
    }

    // プレイヤーテクスチャ切替
    this.player.setTexture("player_shoot");
    this.time.delayedCall(150, () => {
      if (!this.isDefending && this.player.active) {
        this.player.setTexture(SPRITE_KEYS.player);
      }
    });

    // マズルフラッシュ（強化版）
    const flash = this.add.circle(gunX + 10, gunY, 6, 0xffffff, 1).setDepth(60);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      duration: 80,
      onComplete: () => flash.destroy(),
    });

    // 薬莢（落下 + フェードアウト）
    const shell = this.add
      .rectangle(gunX, gunY + 4, 3, 6, 0x8a7a3a)
      .setDepth(40);
    this.tweens.add({
      targets: shell,
      x: gunX - 10 - Math.random() * 10,
      y: this.getGroundYAtX(gunX - 12) - 4,
      angle: 180,
      duration: 400,
      ease: "Quad.easeIn",
      onComplete: () => {
        this.tweens.add({
          targets: shell,
          alpha: 0,
          delay: 1000,
          duration: 300,
          onComplete: () => shell.destroy(),
        });
      },
    });

    // 弾倉が空なら自動リロード
    if (this.magAmmo[this.currentWeapon] <= 0) {
      this.reload();
    }
  }

  private switchWeapon(index: number): void {
    if (index < 0 || index >= WEAPONS.length) return;
    this.currentWeapon = index;
    for (let i = 0; i < this.weaponTexts.length; i++) {
      this.weaponTexts[i].setColor(i === index ? "#ffcc00" : "#666666");
    }
  }

  private reload(): void {
    if (this.isReloading || this.gameOver) return;
    if (this.pausedReloadDuration > 0) {
      this.resumeReload();
      return;
    }
    const weapon = WEAPONS[this.currentWeapon];
    const reserve = this.reserveAmmo[this.currentWeapon];

    // 予備弾がない（無限弾でもない）場合、拳銃に切替
    if (reserve <= 0 && reserve !== Number.POSITIVE_INFINITY) {
      if (this.currentWeapon !== 0) {
        this.switchWeapon(0);
      }
      return;
    }

    // 弾倉が満タンなら不要
    if (this.magAmmo[this.currentWeapon] >= weapon.magSize) return;

    this.reloadTotalDuration = weapon.reloadTime;
    this.reloadCompletedDuration = 0;
    this.startReloadTimer(weapon.reloadTime);
  }

  private startReloadTimer(duration: number): void {
    this.isReloading = true;
    this.reloadStartedAt = this.time.now;
    this.reloadDuration = duration;
    this.pausedReloadDuration = 0;
    SoundSynth.reload();
    this.player.setTexture("player_reload");
    this.reloadTimer = this.time.delayedCall(duration, () => {
      if (!this.player.active) return;
      this.isReloading = false;
      this.reloadStartedAt = 0;
      this.reloadDuration = 0;
      this.reloadTotalDuration = 0;
      this.reloadCompletedDuration = 0;
      this.pausedReloadDuration = 0;
      this.reloadTimer = undefined;

      const weapon = WEAPONS[this.currentWeapon];
      const needed = weapon.magSize - this.magAmmo[this.currentWeapon];
      if (this.reserveAmmo[this.currentWeapon] === Number.POSITIVE_INFINITY) {
        this.magAmmo[this.currentWeapon] = weapon.magSize;
      } else {
        const fill = Math.min(needed, this.reserveAmmo[this.currentWeapon]);
        this.magAmmo[this.currentWeapon] += fill;
        this.reserveAmmo[this.currentWeapon] -= fill;
      }

      if (!this.isDefending) {
        this.player.setTexture(SPRITE_KEYS.player);
      }
    });
  }

  private pauseReload(): void {
    if (!this.isReloading) return;
    const elapsed = this.time.now - this.reloadStartedAt;
    this.reloadCompletedDuration = Math.min(
      this.reloadTotalDuration,
      this.reloadCompletedDuration + elapsed
    );
    this.pausedReloadDuration = Math.max(0, this.reloadDuration - elapsed);
    this.isReloading = false;
    this.reloadStartedAt = 0;
    this.reloadDuration = 0;
    this.reloadTimer?.destroy();
    this.reloadTimer = undefined;
  }

  private resumeReload(): void {
    if (this.isReloading || this.pausedReloadDuration <= 0 || this.gameOver)
      return;
    this.startReloadTimer(this.pausedReloadDuration);
  }

  private cancelReload(): void {
    this.pauseReload();
    this.reloadTotalDuration = 0;
    this.reloadCompletedDuration = 0;
    this.pausedReloadDuration = 0;

    if (!this.isDefending && this.player.active) {
      this.player.setTexture(SPRITE_KEYS.player);
    }
  }

  private startDefend(): void {
    if (this.isDefending || this.gameOver) return;
    this.pauseReload();
    this.isDefending = true;
    SoundSynth.defend();
    this.player.setTexture(SPRITE_KEYS.playerDefend);
    this.defendShield
      ?.setPosition(this.player.x + 12, this.player.y)
      .setVisible(true)
      .setAlpha(0.45);
  }

  private stopDefend(): void {
    if (!this.isDefending) return;
    this.isDefending = false;
    this.defendShield?.setVisible(false);
    if (this.pausedReloadDuration > 0) {
      this.resumeReload();
    } else if (!this.isReloading && this.player.active) {
      this.player.setTexture(SPRITE_KEYS.player);
    }
  }

  private shiftWorld(amount: number): void {
    if (amount === 0) return;

    this.shiftLoopingLayer(this.cloudLayer, amount * 0.15, 140);
    this.shiftLoopingLayer(this.mountainLayer, amount * 0.4, 170);
    this.scrollTerrain(amount);

    for (const bullet of this.playerBulletList) {
      if (bullet.active) bullet.x += amount;
    }
    for (const bullet of this.enemyBulletList) {
      if (bullet.active) bullet.x += amount;
    }
    for (const mark of this.bulletMarks) {
      if (mark.active) {
        mark.x += amount;
        mark.y = this.getGroundYAtX(mark.x) - 6;
      }
    }

    const enemies = this.enemies.getChildren() as Phaser.Physics.Arcade.Image[];
    for (const enemy of enemies) {
      if (!enemy.active) continue;
      enemy.x += amount;
      if (!enemy.getData("isHeli") && enemy.getData("landed") !== false) {
        enemy.y = this.getGroundYAtX(enemy.x) - 24;
      }
      const hpBar = enemy.getData("hpBar") as
        | Phaser.GameObjects.Rectangle
        | undefined;
      if (hpBar) hpBar.setPosition(enemy.x, enemy.y - 30);
    }

    this.updateCrossMarkers(amount);
  }

  // ============================
  // 敵スポーン
  // ============================

  private setupEnemySpawner(): void {
    // 開始直後は猶予を持たせ、以後は距離連動でスポーン間隔を短縮
    this.time.delayedCall(1200, () => this.spawnEnemy());
    this.time.delayedCall(2600, () => this.spawnEnemy());
    this.scheduleNextEnemySpawn();

    this.heliSpawnTimer = this.time.addEvent({
      delay: 15000,
      callback: () => this.spawnHelicopter(),
      loop: true,
    });

    this.paraSpawnTimer = this.time.addEvent({
      delay: 12000,
      callback: () => this.spawnParatrooper(),
      loop: true,
    });

    this.artilleryTimer = this.time.addEvent({
      delay: 8000,
      callback: () => this.spawnArtillery(),
      loop: true,
    });
  }

  private spawnEnemy(): void {
    if (this.gameOver) return;

    const available = ENEMY_TYPES.filter(e => e.minDistance <= this.distance);
    if (available.length === 0) return;

    const typeDef = available[Math.floor(Math.random() * available.length)];
    const spawnX = GAME_WIDTH + 20 + Math.random() * 40;
    const spawnY = this.getGroundYAtX(spawnX) - 24;
    const enemy = this.physics.add
      .image(spawnX, spawnY, SPRITE_KEYS.enemy)
      .setDepth(30)
      .setFlipX(true)
      .setTint(Phaser.Display.Color.HexStringToColor(typeDef.color).color); // 左向き（プレイヤー方向）

    enemy.setData("hp", typeDef.hp);
    enemy.setData("maxHp", typeDef.hp);
    enemy.setData("type", typeDef.type);
    enemy.setData("damage", typeDef.damage);
    enemy.setData("isHeli", false);
    enemy.setData("magRemaining", typeDef.magSize);
    enemy.setData("isReloading", false);
    this.enemies.add(enemy);

    // Group追加後にvelocityを設定
    const body = enemy.body as Phaser.Physics.Arcade.Body;
    body.setVelocityX(-typeDef.speed);

    // 敵の上にHPバーを表示（視認性向上）
    const hpBar = this.add
      .rectangle(enemy.x, enemy.y - 30, 30, 4, 0x44cc44)
      .setDepth(31);
    enemy.setData("hpBar", hpBar);

    console.log(
      "[GameScene] enemy spawned at x=" +
        enemy.x +
        " vx=" +
        body.velocity.x +
        " type=" +
        typeDef.type
    );

    // 射撃タイマー
    const fireDelay = 1000 + Math.random() * 1000;
    const fireTimer = this.time.addEvent({
      delay: fireDelay,
      callback: () => {
        if (enemy.active && !this.gameOver) {
          this.enemyFire(enemy, typeDef);
        }
      },
      loop: false,
    });
    enemy.setData("fireTimer", fireTimer);

    // 最小接近距離で停止
    const stopCheck = this.time.addEvent({
      delay: 100,
      callback: () => {
        if (!enemy.active) {
          stopCheck.destroy();
          return;
        }
        if (enemy.x <= typeDef.minApproachX) {
          (enemy.body as Phaser.Physics.Arcade.Body).setVelocityX(0);
          fireTimer.destroy();
          const loopingFireTimer = this.time.addEvent({
            delay: typeDef.fireRate,
            callback: () => {
              if (enemy.active && !this.gameOver) {
                this.enemyFire(enemy, typeDef);
              }
            },
            loop: true,
          });
          enemy.setData("fireTimer", loopingFireTimer);
          stopCheck.destroy();
        }
      },
      loop: true,
    });
  }

  private scheduleNextEnemySpawn(): void {
    if (this.gameOver) return;

    let delay = 3000;
    if (this.distance >= 800) {
      delay = 800;
    } else if (this.distance >= 300) {
      delay = 1500;
    }

    this.enemySpawnTimer = this.time.delayedCall(delay, () => {
      this.spawnEnemy();
      this.scheduleNextEnemySpawn();
    });
  }

  private enemyFire(
    enemy: Phaser.GameObjects.Image,
    typeDef: EnemyTypeDef
  ): void {
    if (!enemy.active || this.gameOver) return;

    // 弾倉管理
    const mag = enemy.getData("magRemaining") as number;
    const isReloading = enemy.getData("isReloading") as boolean;
    if (isReloading) return;

    if (mag <= 0) {
      enemy.setData("isReloading", true);
      this.time.delayedCall(typeDef.reloadTime, () => {
        if (enemy.active) {
          enemy.setData("magRemaining", typeDef.magSize);
          enemy.setData("isReloading", false);
        }
      });
      return;
    }

    enemy.setData("magRemaining", mag - 1);

    const targetX = PLAYER_X;
    const targetY = this.player.y;
    const angle =
      Math.atan2(targetY - enemy.y, targetX - enemy.x) +
      (Math.random() - 0.5) * typeDef.spread * 2;

    const bullet = this.add
      .image(enemy.x - 10, enemy.y, SPRITE_KEYS.enemyBullet)
      .setTint(0xff6633)
      .setDepth(50);
    bullet.setData("vx", Math.cos(angle) * typeDef.bulletSpeed);
    bullet.setData("vy", Math.sin(angle) * typeDef.bulletSpeed);
    bullet.setData("damage", typeDef.damage);
    this.enemyBulletList.push(bullet);

    // テクスチャ切替
    enemy.setTexture("enemy_shoot");
    this.time.delayedCall(150, () => {
      if (enemy.active) enemy.setTexture(SPRITE_KEYS.enemy);
    });

    // 2秒後自動破棄
    this.time.delayedCall(2000, () => {
      if (bullet.active) bullet.destroy();
    });
  }

  private spawnHelicopter(): void {
    if (this.gameOver || this.distance < HELI_MIN_DISTANCE) return;

    const fromLeft = Math.random() < 0.5;
    const startX = fromLeft ? -40 : GAME_WIDTH + 40;
    const y = 60 + Math.random() * 40;

    const heli = this.physics.add
      .image(startX, y, SPRITE_KEYS.heli)
      .setDepth(30);
    const body = heli.body as Phaser.Physics.Arcade.Body;
    body.setVelocityX(fromLeft ? HELI_SPEED : -HELI_SPEED);

    heli.setData("hp", HELI_HP);
    heli.setData("type", "helicopter");
    heli.setData("damage", HELI_DAMAGE);
    heli.setData("isHeli", true);
    this.enemies.add(heli);

    // 射撃タイマー
    const fireTimer = this.time.addEvent({
      delay: HELI_FIRE_RATE,
      callback: () => {
        if (heli.active && !this.gameOver) {
          this.heliFire(heli);
        }
      },
      loop: true,
    });
    heli.setData("fireTimer", fireTimer);

    // 12秒後に削除
    this.time.delayedCall(12000, () => {
      if (heli.active) {
        const ft = heli.getData("fireTimer") as Phaser.Time.TimerEvent;
        ft?.destroy();
        heli.destroy();
      }
    });
  }

  private heliFire(heli: Phaser.GameObjects.Image): void {
    if (!heli.active) return;

    const targetX = PLAYER_X;
    const targetY = this.player.y;
    const angle =
      Math.atan2(targetY - heli.y, targetX - heli.x) +
      (Math.random() - 0.5) * 0.1;

    const bullet = this.add
      .image(heli.x, heli.y + 10, SPRITE_KEYS.enemyBullet)
      .setTint(0xff4444)
      .setDepth(50);
    bullet.setData("vx", Math.cos(angle) * 600);
    bullet.setData("vy", Math.sin(angle) * 600);
    bullet.setData("damage", HELI_DAMAGE);
    this.enemyBulletList.push(bullet);

    this.time.delayedCall(2000, () => {
      if (bullet.active) bullet.destroy();
    });
  }

  private spawnParatrooper(): void {
    if (this.gameOver || this.distance < PARA_MIN_DISTANCE) return;

    const x = 150 + Math.random() * (GAME_WIDTH - 200);
    const para = this.physics.add.image(x, -20, SPRITE_KEYS.para).setDepth(30);
    const body = para.body as Phaser.Physics.Arcade.Body;
    body.setVelocityY(PARA_FALL_SPEED);

    para.setData("hp", PARA_HP);
    para.setData("type", "paratrooper");
    para.setData("damage", 10);
    para.setData("isHeli", false);
    para.setData("landed", false);
    this.enemies.add(para);

    // 着地チェック
    const landCheck = this.time.addEvent({
      delay: 100,
      callback: () => {
        if (!para.active) {
          landCheck.destroy();
          return;
        }
        if (para.y >= this.getGroundYAtX(para.x) - 24) {
          body.setVelocityY(0);
          para.y = this.getGroundYAtX(para.x) - 24;
          para.setData("landed", true);
          para.setTexture(SPRITE_KEYS.enemy);
          landCheck.destroy();

          // 着地後の射撃開始
          const handgunDef = ENEMY_TYPES[0];
          const fireTimer = this.time.addEvent({
            delay: handgunDef.fireRate,
            callback: () => {
              if (para.active && !this.gameOver) {
                this.enemyFire(para, handgunDef);
              }
            },
            loop: true,
          });
          para.setData("fireTimer", fireTimer);
          para.setData("magRemaining", handgunDef.magSize);
          para.setData("isReloading", false);
        }
      },
      loop: true,
    });
  }

  private spawnArtillery(): void {
    if (this.gameOver || this.distance < ARTILLERY_MIN_DISTANCE) return;

    const targetX = PLAYER_X - 20 + Math.random() * 60;
    const targetGroundY = this.getGroundYAtX(targetX);

    // 警告表示
    const warning = this.add
      .text(targetX, targetGroundY - 42, "⚠", {
        fontSize: "20px",
        color: "#ff4444",
      })
      .setOrigin(0.5)
      .setDepth(90);

    this.tweens.add({
      targets: warning,
      alpha: 0.3,
      duration: 300,
      yoyo: true,
      repeat: 2,
    });

    // 1.5秒後に着弾
    this.time.delayedCall(1500, () => {
      warning.destroy();
      if (this.gameOver) return;

      // カメラシェイク + 爆発音
      SoundSynth.explosion();
      this.cameras.main.shake(200, 0.01);

      // ダメージ判定
      const dx = Math.abs(this.player.x - targetX);
      if (dx < 40) {
        let dmg = ARTILLERY_DAMAGE;
        if (this.isDefending) dmg = Math.floor(dmg * 0.3);
        this.applyDamage(dmg);
      }

      // 爆発エフェクト
      const explosion = this.add
        .circle(targetX, targetGroundY - 4, 20, 0xff6600, 0.8)
        .setDepth(80);
      this.tweens.add({
        targets: explosion,
        alpha: 0,
        scaleX: 2,
        scaleY: 2,
        duration: 400,
        onComplete: () => explosion.destroy(),
      });
    });
  }

  // ============================
  // 更新ループ
  // ============================

  private updateLogCount = 0;

  update(_time: number, delta: number): void {
    if (this.gameOver) return;

    // デバッグ: 最初の数フレームだけログ
    if (this.updateLogCount < 3) {
      this.updateLogCount++;
      const enemies = this.enemies.getChildren();
      console.log(
        `[GameScene] update #${this.updateLogCount} delta=${Math.round(delta)} enemies=${enemies.length} positions=[${enemies.map((e: Phaser.GameObjects.GameObject) => Math.round((e as Phaser.GameObjects.Image).x)).join(",")}]`
      );
    }

    // タイマー
    this.gameTimer += delta;
    this.playTime = Math.floor(this.gameTimer / 1000);

    // プレイヤー移動（A/D or 矢印キー）
    const moveSpeed = 150; // px/s
    const dt = delta / 1000;
    let worldShift = 0;
    if (this.cursors?.left?.isDown || this.keyA?.isDown) {
      worldShift += moveSpeed * dt;
    }
    if (this.cursors?.right?.isDown || this.keyD?.isDown) {
      worldShift -= moveSpeed * dt;
    }
    if (worldShift !== 0) {
      this.shiftWorld(worldShift);
      if (worldShift < 0) {
        this.distance += -worldShift * GameScene.MOVE_METERS_PER_PIXEL;
      }
    }
    this.player.y = this.getGroundYAtX(this.player.x) - 24;
    this.defendShield?.setPosition(this.player.x + 12, this.player.y);
    this.updatePlayerHpBar();

    // 照準
    const pointer = this.input.activePointer;
    this.crosshair.setPosition(pointer.worldX, pointer.worldY);
    this.updateBackgroundScroll(delta);

    if (this.keyF?.isDown && !this.isDefending && !this.isReloading) {
      this.fire(this.crosshair.x, this.crosshair.y);
    }

    // プレイヤー弾の移動と衝突判定（配列ベース・手動移動）
    const allEnemiesForHit =
      this.enemies.getChildren() as Phaser.Physics.Arcade.Image[];
    for (let bi = this.playerBulletList.length - 1; bi >= 0; bi--) {
      const bullet = this.playerBulletList[bi];
      if (!bullet.active) {
        this.playerBulletList.splice(bi, 1);
        continue;
      }
      // 手動移動
      const bvx = bullet.getData("vx") as number;
      const bvy = bullet.getData("vy") as number;
      const prevX = bullet.x;
      const prevY = bullet.y;
      const nextX = bullet.x + bvx * dt;
      const nextY = bullet.y + bvy * dt;
      const groundHit = this.getGroundCollisionPoint(
        prevX,
        prevY,
        nextX,
        nextY
      );
      bullet.x = nextX;
      bullet.y = nextY;

      if (groundHit) {
        this.createBulletMark(groundHit.x, groundHit.y - 2, 0x4d3822);
        bullet.destroy();
        this.playerBulletList.splice(bi, 1);
        continue;
      }

      // 画面外チェック
      if (
        bullet.x < -10 ||
        bullet.x > GAME_WIDTH + 10 ||
        bullet.y < -10 ||
        bullet.y > GAME_HEIGHT + 10
      ) {
        const groundY = this.getGroundYAtX(
          Phaser.Math.Clamp(bullet.x, 0, GAME_WIDTH)
        );
        if (bullet.y >= groundY - 8) {
          this.createBulletMark(
            Phaser.Math.Clamp(bullet.x, 0, GAME_WIDTH),
            groundY - 6,
            0x4d3822
          );
        }
        bullet.destroy();
        this.playerBulletList.splice(bi, 1);
        continue;
      }

      // 敵との衝突判定
      let hit = false;
      for (const enemy of allEnemiesForHit) {
        if (!enemy.active) continue;
        const dx = Math.abs(bullet.x - enemy.x);
        const dy = Math.abs(bullet.y - enemy.y);
        if (dx < 20 && dy < 30) {
          hit = true;
          const damage = (bullet.getData("damage") as number) ?? 15;
          bullet.destroy();
          this.playerBulletList.splice(bi, 1);

          // ヘッドショット判定
          let finalDamage = damage;
          const enemyTop = enemy.y - enemy.displayHeight / 2;
          const headZoneBottom = enemyTop + enemy.displayHeight * HEADSHOT_ZONE;
          if (bullet.y < headZoneBottom) {
            finalDamage *= HEADSHOT_MULTIPLIER;
            this.headshots++;
            SoundSynth.headshot();
            const hsText = this.add
              .text(enemy.x, enemy.y - 20, "HEADSHOT", {
                fontSize: "10px",
                color: "#ff4444",
                fontFamily: "monospace",
                fontStyle: "bold",
              })
              .setOrigin(0.5)
              .setDepth(90);
            this.tweens.add({
              targets: hsText,
              y: hsText.y - 20,
              alpha: 0,
              duration: 600,
              onComplete: () => hsText.destroy(),
            });
          }

          // ダメージ適用
          const hp = (enemy.getData("hp") as number) - finalDamage;
          enemy.setData("hp", hp);

          // HPバー更新
          const hpBarEl = enemy.getData("hpBar") as
            | Phaser.GameObjects.Rectangle
            | undefined;
          if (hpBarEl) {
            const maxHp = (enemy.getData("maxHp") as number) ?? 30;
            const hpRatio = Math.max(0, hp / maxHp);
            hpBarEl.width = Math.max(0, 30 * hpRatio);
            hpBarEl.setFillStyle(this.getEnemyHpBarColor(hpRatio), 1);
          }

          if (hp <= 0) {
            SoundSynth.hit();
            const ex = enemy.x;
            const ey = enemy.y;
            const ft = enemy.getData("fireTimer") as
              | Phaser.Time.TimerEvent
              | undefined;
            ft?.destroy();
            hpBarEl?.destroy();
            if (enemy.getData("isHeli")) this.heliKills++;
            enemy.destroy();
            this.kills++;
            this.killsSinceAdvance++;
            this.checkAdvance();

            const kp = this.add
              .text(ex, ey, `${this.kills} KILL`, {
                fontSize: "14px",
                color: "#ffcc00",
                fontFamily: "monospace",
                fontStyle: "bold",
              })
              .setOrigin(0.5)
              .setDepth(91);
            this.tweens.add({
              targets: kp,
              scaleX: 1.5,
              scaleY: 1.5,
              duration: 150,
              yoyo: true,
              onComplete: () => {
                this.tweens.add({
                  targets: kp,
                  alpha: 0,
                  y: kp.y - 20,
                  duration: 400,
                  onComplete: () => kp.destroy(),
                });
              },
            });
          } else {
            enemy.setTint(0xff0000);
            this.time.delayedCall(100, () => {
              if (enemy.active) enemy.clearTint();
            });
          }
          break;
        }
      }
      if (hit) continue;
    }

    // 敵弾 vs プレイヤー（近接判定）
    for (let bi = this.enemyBulletList.length - 1; bi >= 0; bi--) {
      const bullet = this.enemyBulletList[bi];
      if (!bullet.active) {
        this.enemyBulletList.splice(bi, 1);
        continue;
      }

      const prevX = bullet.x;
      const prevY = bullet.y;
      const nextX = bullet.x + ((bullet.getData("vx") as number) ?? 0) * dt;
      const nextY = bullet.y + ((bullet.getData("vy") as number) ?? 0) * dt;
      const groundHit = this.getGroundCollisionPoint(
        prevX,
        prevY,
        nextX,
        nextY
      );
      bullet.x = nextX;
      bullet.y = nextY;

      if (groundHit) {
        this.createBulletMark(groundHit.x, groundHit.y - 2, 0x2d1a1a);
        bullet.destroy();
        this.enemyBulletList.splice(bi, 1);
        continue;
      }

      if (
        bullet.x < -10 ||
        bullet.x > GAME_WIDTH + 10 ||
        bullet.y < -10 ||
        bullet.y > GAME_HEIGHT + 10
      ) {
        const groundY = this.getGroundYAtX(
          Phaser.Math.Clamp(bullet.x, 0, GAME_WIDTH)
        );
        if (bullet.y >= groundY - 8) {
          this.createBulletMark(
            Phaser.Math.Clamp(bullet.x, 0, GAME_WIDTH),
            groundY - 6,
            0x2d1a1a
          );
        }
        bullet.destroy();
        this.enemyBulletList.splice(bi, 1);
        continue;
      }

      const dx = Math.abs(bullet.x - this.player.x);
      const dy = Math.abs(bullet.y - this.player.y);
      if (dx < 12 && dy < 20) {
        if (this.isDefending) {
          this.blocks++;
          bullet.destroy();
          this.enemyBulletList.splice(bi, 1);
        } else {
          const dmg = (bullet.getData("damage") as number) ?? 8;
          bullet.destroy();
          this.enemyBulletList.splice(bi, 1);
          this.applyDamage(dmg);
        }
      }
    }

    // 敵のHPバー追従 + 画面外の敵を除去
    const allEnemies =
      this.enemies.getChildren() as Phaser.Physics.Arcade.Image[];
    for (const enemy of allEnemies) {
      if (!enemy.active) continue;
      if (!enemy.getData("isHeli") && enemy.getData("landed") !== false) {
        enemy.y = this.getGroundYAtX(enemy.x) - 24;
      }
      // HPバー追従
      const hpBar = enemy.getData("hpBar") as
        | Phaser.GameObjects.Rectangle
        | undefined;
      if (hpBar) {
        hpBar.setPosition(enemy.x, enemy.y - 30);
      }
      // 画面外除去
      if (enemy.x < -50) {
        const ft = enemy.getData("fireTimer") as
          | Phaser.Time.TimerEvent
          | undefined;
        ft?.destroy();
        hpBar?.destroy();
        enemy.destroy();
      }
    }

    this.updateHUD();
  }

  // ============================
  // ユーティリティ
  // ============================

  private applyDamage(amount: number): void {
    this.playerHp -= amount;
    this.updatePlayerHpBar();

    // 赤フラッシュ
    this.player.setTint(0xff0000);
    if (this.damageOverlay) {
      this.damageOverlay.alpha = 0.22;
      this.tweens.killTweensOf(this.damageOverlay);
      this.tweens.add({
        targets: this.damageOverlay,
        alpha: 0,
        duration: 180,
      });
    }
    this.time.delayedCall(100, () => {
      if (this.player.active) this.player.clearTint();
    });

    if (this.playerHp <= 0) {
      this.playerHp = 0;
      this.onGameOver();
    }
  }

  private checkAdvance(): void {
    if (this.killsSinceAdvance >= KILLS_TO_ADVANCE) {
      this.distance += ADVANCE_DISTANCE;
      this.pendingAdvanceScroll += ADVANCE_DISTANCE * 3.2;
      this.killsSinceAdvance = 0;
    }
  }

  private updateHUD(): void {
    // HP
    const hpColor =
      this.playerHp > 60
        ? "#44cc44"
        : this.playerHp > 30
          ? "#cccc44"
          : "#cc4444";
    this.hpText.setText(`HP: ${this.playerHp}`).setColor(hpColor);

    // 弾薬
    const w = WEAPONS[this.currentWeapon];
    const mag = this.magAmmo[this.currentWeapon];
    const reserve = this.reserveAmmo[this.currentWeapon];
    const reserveStr =
      reserve === Number.POSITIVE_INFINITY ? "∞" : String(reserve);
    const pausedProgress =
      this.pausedReloadDuration > 0 && this.reloadTotalDuration > 0
        ? Phaser.Math.Clamp(
            this.reloadCompletedDuration / this.reloadTotalDuration,
            0,
            1
          )
        : 0;
    const reloadProgress =
      this.isReloading &&
      this.reloadDuration > 0 &&
      this.reloadTotalDuration > 0
        ? Phaser.Math.Clamp(
            (this.reloadCompletedDuration +
              (this.time.now - this.reloadStartedAt)) /
              this.reloadTotalDuration,
            0,
            1
          )
        : pausedProgress;
    const reloadPercent = Math.round(reloadProgress * 100);
    const showReload = this.isReloading || this.pausedReloadDuration > 0;
    const reloadStr = showReload ? ` [RELOAD ${reloadPercent}%]` : "";
    this.ammoText.setText(`${w.nameJa}: ${mag}/${reserveStr}${reloadStr}`);
    this.reloadBarBg?.setVisible(showReload);
    this.reloadBarFill?.setVisible(showReload).setSize(124 * reloadProgress, 4);

    // 距離
    this.distanceText.setText(`${Math.floor(this.distance)}m`);

    // キル
    this.killsText.setText(`KILLS: ${this.kills}`);

    // 時間
    const min = Math.floor(this.playTime / 60);
    const sec = this.playTime % 60;
    this.timeText.setText(
      `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    );
  }

  private updatePlayerHpBar(): void {
    const hpRatio = Phaser.Math.Clamp(this.playerHp / PLAYER_MAX_HP, 0, 1);
    const barColor =
      hpRatio > 0.6 ? 0x44cc44 : hpRatio > 0.3 ? 0xcccc44 : 0xcc4444;
    this.playerHpBarBg?.setPosition(this.player.x, this.player.y - 28);
    this.playerHpBarFill
      ?.setPosition(this.player.x - 14, this.player.y - 28)
      .setSize(28 * hpRatio, 3)
      .setFillStyle(barColor, 1);
  }

  private onGameOver(): void {
    this.gameOver = true;
    this.cancelReload();
    this.stopDefend();
    this.player.setTexture("player_dead");

    // スポーンタイマー停止
    this.enemySpawnTimer?.destroy();
    this.heliSpawnTimer?.destroy();
    this.paraSpawnTimer?.destroy();
    this.artilleryTimer?.destroy();

    const meritPoints =
      this.distance * 2 + this.kills * 10 + this.headshots * 5;

    // GAME OVER テキスト
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, "GAME OVER", {
        fontSize: "28px",
        color: "#cc4444",
        fontFamily: "monospace",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(150);

    // 2秒後にリザルトへ
    this.time.delayedCall(2000, () => {
      const data: GameResultData = {
        distance: this.distance,
        kills: this.kills,
        headshots: this.headshots,
        totalShots: this.totalShots,
        playTime: this.playTime,
        meritPoints,
        blocks: this.blocks,
        heliKills: this.heliKills,
      };
      this.scene.start("ResultScene", data);
    });
  }
}
