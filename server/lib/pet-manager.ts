import { randomUUID } from "node:crypto";
import type {
  Pet,
  PetAction,
  PetGame,
  PetMood,
  PetSpecies,
} from "../../shared/types.js";
import { db } from "./database.js";

/** 動物種ごとのレアリティと出現重み */
const SPECIES_WEIGHTS: { species: PetSpecies; weight: number }[] = [
  { species: "dog", weight: 20 },
  { species: "cat", weight: 20 },
  { species: "rabbit", weight: 20 },
  { species: "bird", weight: 10 },
  { species: "turtle", weight: 10 },
  { species: "penguin", weight: 10 },
  { species: "fox", weight: 5 },
  { species: "owl", weight: 5 },
];

const TOTAL_WEIGHT = SPECIES_WEIGHTS.reduce((sum, s) => sum + s.weight, 0);

/** EXPティック間隔（5分） */
const EXP_TICK_MS = 5 * 60 * 1000;

/** インタラクションクールダウン（30秒） */
const INTERACT_COOLDOWN_MS = 30 * 1000;

/** ミニゲームクールダウン（20分） */
const GAME_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * ペットの成長ロジックを管理するクラス
 *
 * - レアリティ重み付き抽選でペットを生成
 * - 5分ごとのEXP自動加算タイマー
 * - インタラクション（撫でる/エサ）+ 30秒クールダウン
 * - ミニゲーム結果反映 + 20分クールダウン
 * - レベルアップ判定（EXP >= level * 10）
 * - 気分遷移ロジック
 */
export class PetManager {
  private expTimer: ReturnType<typeof setInterval> | null = null;
  private interactCooldowns = new Map<string, number>();
  private gameCooldowns = new Map<string, number>();
  private onPetUpdated: ((pet: Pet) => void) | null = null;
  private onLevelUp: ((petId: string, newLevel: number) => void) | null = null;

  /** コールバック登録 */
  setCallbacks(callbacks: {
    onPetUpdated: (pet: Pet) => void;
    onLevelUp: (petId: string, newLevel: number) => void;
  }): void {
    this.onPetUpdated = callbacks.onPetUpdated;
    this.onLevelUp = callbacks.onLevelUp;
  }

  /** EXP自動加算タイマー開始 */
  startExpTicker(): void {
    if (this.expTimer) return;
    this.expTimer = setInterval(() => this.tickExp(), EXP_TICK_MS);
  }

  /** EXP自動加算タイマー停止 */
  stopExpTicker(): void {
    if (this.expTimer) {
      clearInterval(this.expTimer);
      this.expTimer = null;
    }
  }

  /** セッション作成時にペットを生成 */
  createPetForSession(sessionId: string): Pet {
    const species = this.rollSpecies();
    const id = randomUUID();
    db.createPet({ id, sessionId, species, name: null });
    const pet = db.getPet(id);
    if (!pet) {
      throw new Error(`ペットの作成に失敗しました: ${id}`);
    }
    return pet;
  }

  /** 全ペット取得 */
  getAllPets(): Pet[] {
    return db.getAllPets();
  }

  /** セッションIDからペット取得 */
  getPetBySessionId(sessionId: string): Pet | null {
    return db.getPetBySessionId(sessionId);
  }

  /** ペットとインタラクション（撫でる/エサ） */
  interact(petId: string, action: PetAction): Pet | null {
    const now = Date.now();
    const cooldownKey = `${petId}:${action}`;
    const lastInteract = this.interactCooldowns.get(cooldownKey) ?? 0;
    if (now - lastInteract < INTERACT_COOLDOWN_MS) return null;

    const pet = db.getPet(petId);
    if (!pet) return null;

    this.interactCooldowns.set(cooldownKey, now);

    if (action === "pet") {
      const newMood = this.calculateMoodAfterPet(pet);
      db.updatePet(petId, { mood: newMood });
    } else if (action === "feed") {
      const newHp = Math.min(100, pet.hp + 20);
      const newExp = pet.exp + 2;
      db.updatePet(petId, { hp: newHp, exp: newExp });
      this.checkLevelUp(petId);
    }

    return db.getPet(petId);
  }

  /** ペット名前変更 */
  rename(petId: string, name: string): Pet | null {
    const pet = db.getPet(petId);
    if (!pet) return null;
    db.updatePet(petId, { name });
    return db.getPet(petId);
  }

  /** ミニゲーム結果を反映 */
  applyGameResult(petId: string, game: PetGame, score: number): Pet | null {
    const now = Date.now();
    const cooldownKey = `${petId}:${game}`;
    const lastGame = this.gameCooldowns.get(cooldownKey) ?? 0;
    if (now - lastGame < GAME_COOLDOWN_MS) return null;

    const pet = db.getPet(petId);
    if (!pet) return null;

    this.gameCooldowns.set(cooldownKey, now);

    let expGain = 0;
    let hpGain = 0;

    if (game === "feeding") {
      hpGain = Math.min(30, score * 2);
      expGain = Math.floor(score / 2);
    } else if (game === "arkdash") {
      expGain = Math.floor(score / 10);
    }

    const newHp = Math.min(100, pet.hp + hpGain);
    const newExp = pet.exp + expGain;
    db.updatePet(petId, { hp: newHp, exp: newExp });
    this.checkLevelUp(petId);

    return db.getPet(petId);
  }

  /** セッション停止時のペット処理（削除はしない、気分をsleepyに） */
  onSessionStopped(sessionId: string): void {
    const pet = db.getPetBySessionId(sessionId);
    if (pet) {
      db.updatePet(pet.id, { mood: "sleepy" });
    }
  }

  /** セッション削除時にペットも削除 */
  onSessionDeleted(sessionId: string): void {
    db.deletePetBySessionId(sessionId);
  }

  /**
   * サーバー起動時に既存セッションへペットを補完する
   * 循環依存を避けるため、セッション一覧を引数として受け取る
   */
  backfillExistingSessions(sessions: { id: string }[]): Pet[] {
    const created: Pet[] = [];
    for (const session of sessions) {
      const existing = db.getPetBySessionId(session.id);
      if (!existing) {
        const pet = this.createPetForSession(session.id);
        created.push(pet);
      }
    }
    return created;
  }

  // --- Private ---

  /** レアリティに基づく重み付きランダム抽選 */
  private rollSpecies(): PetSpecies {
    let roll = Math.random() * TOTAL_WEIGHT;
    for (const entry of SPECIES_WEIGHTS) {
      roll -= entry.weight;
      if (roll <= 0) return entry.species;
    }
    return "dog";
  }

  /** 5分ごとのEXPティック */
  private tickExp(): void {
    const pets = db.getAllPets();
    for (const pet of pets) {
      const moodMultiplier = pet.mood === "happy" ? 2 : 1;
      const expGain = 1 * moodMultiplier;
      const newExp = pet.exp + expGain;
      const newHp = Math.max(0, pet.hp - 1);
      const newMood = this.calculateMood(newHp, pet.mood);
      db.updatePet(pet.id, { exp: newExp, hp: newHp, mood: newMood });
      this.checkLevelUp(pet.id);

      const updated = db.getPet(pet.id);
      if (updated && this.onPetUpdated) {
        this.onPetUpdated(updated);
      }
    }
  }

  /** 気分算出（HP値に基づき気分を遷移） */
  private calculateMood(hp: number, currentMood: PetMood): PetMood {
    if (hp < 30) return "hungry";
    if (hp < 50) return currentMood === "happy" ? "neutral" : currentMood;
    return currentMood;
  }

  /** 撫でた後の気分算出 */
  private calculateMoodAfterPet(pet: Pet): PetMood {
    if (pet.hp > 80) return "happy";
    if (pet.hp > 50) return "happy";
    return "neutral";
  }

  /** レベルアップ判定（EXP >= level * 10） */
  private checkLevelUp(petId: string): void {
    const pet = db.getPet(petId);
    if (!pet) return;
    const requiredExp = pet.level * 10;
    if (pet.exp >= requiredExp) {
      const newLevel = pet.level + 1;
      const remainingExp = pet.exp - requiredExp;
      db.updatePet(petId, { level: newLevel, exp: remainingExp });
      if (this.onLevelUp) {
        this.onLevelUp(petId, newLevel);
      }
    }
  }
}

/** シングルトンインスタンス */
export const petManager = new PetManager();
