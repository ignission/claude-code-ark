// FrontLine ゲーム定数定義

// --- 画面・レイアウト ---
export const GAME_WIDTH = 640;
export const GAME_HEIGHT = 400;
export const GROUND_Y = 320;
export const HUD_HEIGHT = 80;
export const PLAYER_X = 80;

// --- プレイヤー ---
export const PLAYER_MAX_HP = 100;
export const DEFENSE_DURATION = 1000;
export const DEFENSE_COOLDOWN = 500;

// --- ヘリコプター ---
export const HELI_HP = 120;
export const HELI_SPEED = 60;
export const HELI_FIRE_RATE = 300;
export const HELI_DAMAGE = 6;
export const HELI_MIN_DISTANCE = 1000;

// --- パラシュート兵 ---
export const PARA_HP = 35;
export const PARA_FALL_SPEED = 50;
export const PARA_MIN_DISTANCE = 800;

// --- 砲撃 ---
export const ARTILLERY_DAMAGE = 40;
export const ARTILLERY_MIN_DISTANCE = 1500;
export const ARTILLERY_INTERVAL = 5000;

// --- 前進 ---
export const KILLS_TO_ADVANCE = 5;
export const ADVANCE_DISTANCE = 10;
export const ADVANCE_SPEED = 2;

// --- ヘッドショット ---
export const HEADSHOT_ZONE = 0.2;
export const HEADSHOT_MULTIPLIER = 2;
export const SNIPER_HEADSHOT_BONUS = 50;

// --- 武器定義 ---
export interface WeaponDef {
  name: string;
  nameJa: string;
  key: string;
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  fireRate: number;
  damage: number;
  bulletSpeed: number;
  spread: number;
  pellets: number;
  bulletSize: number;
  bulletColor: string;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    name: "Handgun",
    nameJa: "拳銃",
    key: "1",
    magSize: 12,
    reserveAmmo: Infinity,
    reloadTime: 1500,
    fireRate: 250,
    damage: 18,
    bulletSpeed: 800,
    spread: 0.02,
    pellets: 1,
    bulletSize: 2,
    bulletColor: "#ffcc00",
  },
  {
    name: "Machinegun",
    nameJa: "機関銃",
    key: "2",
    magSize: 30,
    reserveAmmo: 60,
    reloadTime: 2000,
    fireRate: 80,
    damage: 7,
    bulletSpeed: 900,
    spread: 0.08,
    pellets: 1,
    bulletSize: 2,
    bulletColor: "#ffaa00",
  },
  {
    name: "Shotgun",
    nameJa: "散弾銃",
    key: "3",
    magSize: 6,
    reserveAmmo: 24,
    reloadTime: 2500,
    fireRate: 600,
    damage: 14,
    bulletSpeed: 700,
    spread: 0.1,
    pellets: 5,
    bulletSize: 3,
    bulletColor: "#ff6600",
  },
  {
    name: "Sniper",
    nameJa: "狙撃銃",
    key: "4",
    magSize: 5,
    reserveAmmo: 20,
    reloadTime: 3000,
    fireRate: 1000,
    damage: 55,
    bulletSpeed: 1200,
    spread: 0.005,
    pellets: 1,
    bulletSize: 4,
    bulletColor: "#ff0000",
  },
  {
    name: "Grenade",
    nameJa: "手榴弾",
    key: "5",
    magSize: 5,
    reserveAmmo: 0,
    reloadTime: 0,
    fireRate: 1500,
    damage: 100,
    bulletSpeed: 350,
    spread: 0,
    pellets: 1,
    bulletSize: 6,
    bulletColor: "#336633",
  },
] as const;

// --- 狙撃銃貫通 ---
export const SNIPER_PENETRATION = 3; // 最大貫通数（3体まで貫通）
export const SNIPER_PENETRATION_DAMAGE_DECAY = 0.7; // 貫通ごとのダメージ減衰率

// --- 手榴弾定数 ---
export const GRENADE_GRAVITY = 400;
export const GRENADE_BLAST_RADIUS = 60;
export const GRENADE_FUSE_TIME = 0; // 着弾即爆発

// --- 敵タイプ定義 ---
export interface EnemyTypeDef {
  type: string;
  hp: number;
  speed: number;
  damage: number;
  fireRate: number;
  magSize: number;
  reloadTime: number;
  minDistance: number;
  color: string;
  minApproachX: number;
  bulletSpeed: number;
  spread: number;
}

export const ENEMY_TYPES: readonly EnemyTypeDef[] = [
  {
    type: "handgun",
    hp: 30,
    speed: 46,
    damage: 8,
    fireRate: 1200,
    magSize: 8,
    reloadTime: 2000,
    minDistance: 0,
    color: "#4a7a4a",
    minApproachX: 200,
    bulletSpeed: 500,
    spread: 0.08,
  },
  {
    type: "machinegun",
    hp: 40,
    speed: 40,
    damage: 5,
    fireRate: 200,
    magSize: 15,
    reloadTime: 2500,
    minDistance: 200,
    color: "#5a5a4a",
    minApproachX: 250,
    bulletSpeed: 600,
    spread: 0.1,
  },
  {
    type: "shotgun",
    hp: 50,
    speed: 52,
    damage: 10,
    fireRate: 800,
    magSize: 4,
    reloadTime: 3000,
    minDistance: 400,
    color: "#6a4a3a",
    minApproachX: 150,
    bulletSpeed: 450,
    spread: 0.15,
  },
  {
    type: "sniper",
    hp: 25,
    speed: 22,
    damage: 25,
    fireRate: 2500,
    magSize: 5,
    reloadTime: 3500,
    minDistance: 600,
    color: "#3a3a5a",
    minApproachX: 400,
    bulletSpeed: 1000,
    spread: 0.01,
  },
] as const;

// --- 階級 ---
export interface RankDef {
  name: string;
  threshold: number;
}

export const RANKS: readonly RankDef[] = [
  { name: "二等兵", threshold: 0 },
  { name: "一等兵", threshold: 500 },
  { name: "上等兵", threshold: 1500 },
  { name: "兵長", threshold: 4000 },
  { name: "伍長", threshold: 10000 },
  { name: "軍曹", threshold: 25000 },
  { name: "曹長", threshold: 60000 },
  { name: "少尉", threshold: 120000 },
  { name: "中尉", threshold: 250000 },
  { name: "大尉", threshold: 500000 },
] as const;

// --- 勲章 ---
export interface MedalDef {
  id: string;
  name: string;
}

export const MEDALS: readonly MedalDef[] = [
  { id: "first_battle", name: "初陣記章" },
  { id: "hundred_kills", name: "百人斬記章" },
  { id: "precision", name: "精密射撃記章" },
  { id: "long_advance", name: "長距離進攻記章" },
  { id: "blitz", name: "短期決戦記章" },
  { id: "heli_down", name: "ヘリ撃墜記章" },
  { id: "iron_wall", name: "鉄壁記章" },
  { id: "veteran", name: "歴戦記章" },
] as const;

// --- 司令官コメント ---
export const COMMANDER_COMMENTS = {
  poor: [
    "訓練が足りんな。もう一度やり直せ。",
    "この程度では前線に出せんぞ。",
    "まだまだだ。精進せよ。",
  ],
  average: [
    "まずまずの戦果だ。次に期待する。",
    "悪くない。だがもっとやれるはずだ。",
    "及第点だ。油断するなよ。",
  ],
  good: [
    "見事な戦いぶりだ。誇りに思う。",
    "素晴らしい戦果だ。昇進も近いぞ。",
    "よくやった。部隊の模範だな。",
  ],
  excellent: [
    "圧倒的だ！伝説の兵士と呼ばれる日も近い。",
    "完璧な作戦遂行だ。敬礼する。",
    "歴史に名を刻む戦果だ。称えよう。",
  ],
} as const;

// --- スプライトキー ---
export const SPRITE_KEYS = {
  player: "player",
  playerDefend: "player_defend",
  enemy: "enemy",
  bullet: "bullet",
  enemyBullet: "enemy_bullet",
  heli: "heli",
  para: "para",
  parachute: "parachute",
  explosion: "explosion",
  muzzleFlash: "muzzle_flash",
  ground: "ground",
  sky: "sky",
  mountain: "mountain",
  building: "building",
  tree: "tree",
  artilleryWarning: "artillery_warning",
  artilleryImpact: "artillery_impact",
} as const;
