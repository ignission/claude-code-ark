// FrontLine GameScene — メインゲームロジック

import Phaser from "phaser";

import { SoundSynth } from "../audio/sound-synth";
import {
  ADVANCE_DISTANCE,
  ARTILLERY_DAMAGE,
  ARTILLERY_MIN_DISTANCE,
  DEFENSE_DURATION,
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
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;

  // --- Phaser オブジェクト ---
  private player!: Phaser.GameObjects.Image;
  private crosshair!: Phaser.GameObjects.Image;
  private enemies!: Phaser.Physics.Arcade.Group;
  private playerBullets!: Phaser.Physics.Arcade.Group;
  private enemyBullets!: Phaser.Physics.Arcade.Group;

  // --- HUD テキスト ---
  private hpText!: Phaser.GameObjects.Text;
  private ammoText!: Phaser.GameObjects.Text;
  private weaponTexts: Phaser.GameObjects.Text[] = [];
  private distanceText!: Phaser.GameObjects.Text;
  private killsText!: Phaser.GameObjects.Text;
  private timeText!: Phaser.GameObjects.Text;

  // --- タイマー ---
  private enemySpawnTimer?: Phaser.Time.TimerEvent;
  private heliSpawnTimer?: Phaser.Time.TimerEvent;
  private paraSpawnTimer?: Phaser.Time.TimerEvent;
  private artilleryTimer?: Phaser.Time.TimerEvent;

  constructor() {
    super({ key: "GameScene" });
  }

  create(): void {
    console.log("[GameScene] create() start");
    try {
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
    const rainGfx = this.add.graphics().setDepth(90);
    this.time.addEvent({
      delay: 50,
      loop: true,
      callback: () => {
        rainGfx.clear();
        rainGfx.lineStyle(1, 0x6688aa, 0.3);
        for (let i = 0; i < 40; i++) {
          const x = Math.random() * GAME_WIDTH;
          const y = Math.random() * GROUND_Y;
          rainGfx.beginPath();
          rainGfx.moveTo(x, y);
          rainGfx.lineTo(x - 4, y + 10);
          rainGfx.strokePath();
        }
      },
    });
  }

  shutdown(): void {
    this.game.events.off("mobile:action", this.handleMobileAction, this);
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

    this.magAmmo = WEAPONS.map(w => w.magSize);
    this.reserveAmmo = WEAPONS.map(w => w.reserveAmmo);
  }

  private createBackground(): void {
    // 空グラデーション
    const skyGfx = this.add.graphics();
    skyGfx.fillGradientStyle(0x1a2a4a, 0x1a2a4a, 0x4a6a8a, 0x4a6a8a, 1);
    skyGfx.fillRect(0, 0, GAME_WIDTH, GROUND_Y);

    // 山のシルエット
    const mtnGfx = this.add.graphics();
    mtnGfx.fillStyle(0x2a3a2a, 1);
    mtnGfx.beginPath();
    mtnGfx.moveTo(0, GROUND_Y);
    mtnGfx.lineTo(80, GROUND_Y - 60);
    mtnGfx.lineTo(160, GROUND_Y - 30);
    mtnGfx.lineTo(240, GROUND_Y - 80);
    mtnGfx.lineTo(320, GROUND_Y - 40);
    mtnGfx.lineTo(400, GROUND_Y - 70);
    mtnGfx.lineTo(480, GROUND_Y - 20);
    mtnGfx.lineTo(560, GROUND_Y - 50);
    mtnGfx.lineTo(GAME_WIDTH, GROUND_Y - 30);
    mtnGfx.lineTo(GAME_WIDTH, GROUND_Y);
    mtnGfx.closePath();
    mtnGfx.fillPath();

    // 地面
    this.add.rectangle(
      GAME_WIDTH / 2,
      GROUND_Y + (GAME_HEIGHT - GROUND_Y - HUD_HEIGHT) / 2,
      GAME_WIDTH,
      GAME_HEIGHT - GROUND_Y - HUD_HEIGHT,
      0x5a4a2a
    );

    // 土嚢
    this.add.image(PLAYER_X + 30, GROUND_Y - 8, "sandbag");

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
    this.player = this.add.image(PLAYER_X, GROUND_Y - 24, SPRITE_KEYS.player);
    this.crosshair = this.add
      .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "crosshair")
      .setDepth(200);

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

    // 武器名テキスト
    this.weaponTexts = [];
    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      const txt = this.add
        .text(8 + i * 90, hudTop + 32, `${w.key}:${w.nameJa}`, {
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
    this.playerBullets = this.physics.add.group();
    this.enemyBullets = this.physics.add.group();
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

    keyboard.on("keydown-ONE", () => this.switchWeapon(0));
    keyboard.on("keydown-TWO", () => this.switchWeapon(1));
    keyboard.on("keydown-THREE", () => this.switchWeapon(2));
    keyboard.on("keydown-FOUR", () => this.switchWeapon(3));
    keyboard.on("keydown-R", () => this.reload());
    keyboard.on("keydown-SPACE", () => this.defend());
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
        this.defend();
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

    const gunX = PLAYER_X + 20;
    const gunY = GROUND_Y - 30;
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

      const bullet = this.physics.add
        .image(gunX, gunY, SPRITE_KEYS.bullet)
        .setDepth(50);
      const body = bullet.body as Phaser.Physics.Arcade.Body;
      body.setVelocity(vx, vy);
      bullet.setData("damage", weapon.damage);
      this.playerBullets.add(bullet);

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
      y: GROUND_Y - 4,
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

    this.isReloading = true;
    SoundSynth.reload();
    this.player.setTexture("player_reload");

    this.time.delayedCall(weapon.reloadTime, () => {
      if (!this.player.active) return;
      this.isReloading = false;

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

  private defend(): void {
    if (this.isDefending || this.gameOver) return;
    this.isDefending = true;
    SoundSynth.defend();
    this.player.setTexture(SPRITE_KEYS.playerDefend);

    this.time.delayedCall(DEFENSE_DURATION, () => {
      this.isDefending = false;
      if (!this.isReloading && this.player.active) {
        this.player.setTexture(SPRITE_KEYS.player);
      }
    });
  }

  // ============================
  // 敵スポーン
  // ============================

  private setupEnemySpawner(): void {
    // 最初の敵を即座にスポーン（開始直後に戦闘開始）
    this.spawnEnemy();
    this.time.delayedCall(800, () => this.spawnEnemy());

    this.enemySpawnTimer = this.time.addEvent({
      delay: 2000,
      callback: () => this.spawnEnemy(),
      loop: true,
    });

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
    // 画面内のランダムな位置に直接スポーン（画面外からの待ち時間なし）
    const spawnX = GAME_WIDTH - 40 - Math.random() * (GAME_WIDTH * 0.4);
    const enemy = this.physics.add
      .image(spawnX, GROUND_Y - 24, SPRITE_KEYS.enemy)
      .setDepth(30)
      .setFlipX(true); // 左向き（プレイヤー方向）

    enemy.setData("hp", typeDef.hp);
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
      .rectangle(enemy.x, enemy.y - 30, 30, 4, 0xff0000)
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
    const fireTimer = this.time.addEvent({
      delay: typeDef.fireRate,
      callback: () => {
        if (enemy.active && !this.gameOver) {
          this.enemyFire(enemy, typeDef);
        }
      },
      loop: true,
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
          stopCheck.destroy();
        }
      },
      loop: true,
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
    const targetY = GROUND_Y - 24;
    const angle =
      Math.atan2(targetY - enemy.y, targetX - enemy.x) +
      (Math.random() - 0.5) * typeDef.spread * 2;

    const bullet = this.physics.add
      .image(enemy.x - 10, enemy.y, SPRITE_KEYS.enemyBullet)
      .setTint(0xff6633)
      .setDepth(50);
    const body = bullet.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(
      Math.cos(angle) * typeDef.bulletSpeed,
      Math.sin(angle) * typeDef.bulletSpeed
    );
    bullet.setData("damage", typeDef.damage);
    this.enemyBullets.add(bullet);

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
    const targetY = GROUND_Y - 24;
    const angle =
      Math.atan2(targetY - heli.y, targetX - heli.x) +
      (Math.random() - 0.5) * 0.1;

    const bullet = this.physics.add
      .image(heli.x, heli.y + 10, SPRITE_KEYS.enemyBullet)
      .setTint(0xff4444)
      .setDepth(50);
    const body = bullet.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(Math.cos(angle) * 600, Math.sin(angle) * 600);
    bullet.setData("damage", HELI_DAMAGE);
    this.enemyBullets.add(bullet);

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
        if (para.y >= GROUND_Y - 24) {
          body.setVelocityY(0);
          para.y = GROUND_Y - 24;
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

    // 警告表示
    const warning = this.add
      .text(targetX, GROUND_Y - 50, "⚠", {
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
        .circle(targetX, GROUND_Y - 4, 20, 0xff6600, 0.8)
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
    if (this.cursors?.left?.isDown || this.keyA?.isDown) {
      this.player.x = Math.max(20, this.player.x - moveSpeed * dt);
    }
    if (this.cursors?.right?.isDown || this.keyD?.isDown) {
      this.player.x = Math.min(
        GAME_WIDTH * 0.6,
        this.player.x + moveSpeed * dt
      );
    }

    // 照準
    const pointer = this.input.activePointer;
    this.crosshair.setPosition(pointer.worldX, pointer.worldY);

    // プレイヤー弾 vs 敵
    this.physics.overlap(
      this.playerBullets,
      this.enemies,
      (_bulletObj, _enemyObj) => {
        const bullet = _bulletObj as Phaser.Physics.Arcade.Image;
        const enemy = _enemyObj as Phaser.Physics.Arcade.Image;

        if (!bullet.active || !enemy.active) return;

        const damage = bullet.getData("damage") as number;
        bullet.destroy();

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
        let hp = enemy.getData("hp") as number;
        hp -= finalDamage;
        enemy.setData("hp", hp);

        if (hp <= 0) {
          // 撃破
          SoundSynth.hit();
          const enemyX = enemy.x;
          const enemyY = enemy.y;
          const ft = enemy.getData("fireTimer") as
            | Phaser.Time.TimerEvent
            | undefined;
          ft?.destroy();
          const hpBarRef = enemy.getData("hpBar") as
            | Phaser.GameObjects.Rectangle
            | undefined;
          hpBarRef?.destroy();
          enemy.destroy();
          this.kills++;
          if (enemy.getData("isHeli")) {
            this.heliKills++;
          }
          this.killsSinceAdvance++;
          this.checkAdvance();

          // キル数ポップアップ
          const killPopup = this.add
            .text(enemyX, enemyY, `${this.kills} KILL`, {
              fontSize: "14px",
              color: "#ffcc00",
              fontFamily: "monospace",
              fontStyle: "bold",
            })
            .setOrigin(0.5)
            .setDepth(91);
          this.tweens.add({
            targets: killPopup,
            scaleX: 1.5,
            scaleY: 1.5,
            duration: 150,
            yoyo: true,
            onComplete: () => {
              this.tweens.add({
                targets: killPopup,
                alpha: 0,
                y: killPopup.y - 20,
                duration: 400,
                onComplete: () => killPopup.destroy(),
              });
            },
          });
        } else {
          // 被弾エフェクト
          enemy.setTint(0xff0000);
          this.time.delayedCall(100, () => {
            if (enemy.active) enemy.clearTint();
          });
        }
      }
    );

    // 敵弾 vs プレイヤー（近接判定）
    const eBullets =
      this.enemyBullets.getChildren() as Phaser.Physics.Arcade.Image[];
    for (const bullet of eBullets) {
      if (!bullet.active) continue;
      const dx = Math.abs(bullet.x - this.player.x);
      const dy = Math.abs(bullet.y - this.player.y);
      if (dx < 12 && dy < 20) {
        if (this.isDefending) {
          this.blocks++;
          bullet.destroy();
        } else {
          const dmg = (bullet.getData("damage") as number) ?? 8;
          bullet.destroy();
          this.applyDamage(dmg);
        }
      }
    }

    // 敵のHPバー追従 + 画面外の敵を除去
    const allEnemies =
      this.enemies.getChildren() as Phaser.Physics.Arcade.Image[];
    for (const enemy of allEnemies) {
      if (!enemy.active) continue;
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

    // 赤フラッシュ
    this.player.setTint(0xff0000);
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
    const reloadStr = this.isReloading ? " [RELOAD]" : "";
    this.ammoText.setText(`${w.nameJa}: ${mag}/${reserveStr}${reloadStr}`);

    // 距離
    this.distanceText.setText(`${this.distance}m`);

    // キル
    this.killsText.setText(`KILLS: ${this.kills}`);

    // 時間
    const min = Math.floor(this.playTime / 60);
    const sec = this.playTime % 60;
    this.timeText.setText(
      `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    );
  }

  private onGameOver(): void {
    this.gameOver = true;
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
