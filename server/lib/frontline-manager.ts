/**
 * フロントラインゲームのサーバーサイド管理
 *
 * 戦績記録・統計・勲章・階級を管理するシングルトンクラス
 */

import { randomUUID } from "node:crypto";
import type {
  FrontlineRecord,
  FrontlineRecordSaved,
  FrontlineStats,
} from "../../shared/types.js";
import { db } from "./database.js";

/** 階級定義 */
interface RankDef {
  readonly name: string;
  readonly threshold: number;
}

const RANKS: readonly RankDef[] = [
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

/** 勲章チェック定義 */
interface MedalCheck {
  readonly id: string;
  readonly check: (
    record: Omit<FrontlineRecord, "id" | "createdAt">,
    stats: FrontlineStats
  ) => boolean;
}

const MEDAL_CHECKS: readonly MedalCheck[] = [
  {
    id: "first_battle",
    check: (_record, stats) => stats.totalPlays === 1,
  },
  {
    id: "hundred_kills",
    check: record => record.kills >= 100,
  },
  {
    id: "precision",
    check: (_record, stats) =>
      stats.totalShots >= 20 &&
      stats.totalHeadshots / stats.totalShots >= 0.5,
  },
  {
    id: "long_advance",
    check: record => record.distance >= 2000,
  },
  {
    id: "blitz",
    check: record => record.playTime <= 300 && record.distance >= 1000,
  },
  {
    id: "heli_down",
    check: record => record.heliKills > 0,
  },
  {
    id: "iron_wall",
    check: record => record.blocks >= 10,
  },
  {
    id: "veteran",
    check: (_record, stats) => stats.totalPlays >= 50,
  },
] as const;

/** デフォルト統計 */
function createDefaultStats(): FrontlineStats {
  return {
    totalPlays: 0,
    totalPlayTime: 0,
    totalKills: 0,
    totalHeadshots: 0,
    totalShots: 0,
    totalMeritPoints: 0,
    bestDistance: 0,
    bestKills: 0,
    rank: "二等兵",
    playHours: {},
    medals: [],
    deathPositions: [],
  };
}

/**
 * 累積功績ポイントから階級を算出
 */
function calcRank(totalMeritPoints: number): string {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (totalMeritPoints >= RANKS[i].threshold) {
      return RANKS[i].name;
    }
  }
  return RANKS[0].name;
}

class FrontlineManager {
  /**
   * 統計を取得（存在しなければデフォルト作成）
   */
  getStats(): FrontlineStats {
    const stats = db.getFrontlineStats();
    if (stats) return stats;
    const defaultStats = createDefaultStats();
    db.upsertFrontlineStats(defaultStats);
    return defaultStats;
  }

  /**
   * 記録一覧を取得
   */
  getRecords(limit?: number): FrontlineRecord[] {
    return db.getFrontlineRecords(limit ?? 50);
  }

  /**
   * 戦績を保存し統計を更新
   */
  saveRecord(
    input: Omit<FrontlineRecord, "id" | "createdAt">
  ): FrontlineRecordSaved {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    const record: FrontlineRecord = {
      ...input,
      id,
      createdAt,
    };

    // DB保存
    db.createFrontlineRecord(record);

    // 統計更新
    const stats = this.getStats();
    const newBestDistance = input.distance > stats.bestDistance;
    const newBestKills = input.kills > stats.bestKills;

    stats.totalPlays += 1;
    stats.totalPlayTime += input.playTime;
    stats.totalKills += input.kills;
    stats.totalHeadshots += input.headshots;
    stats.totalShots += input.totalShots;
    stats.totalMeritPoints += input.meritPoints;
    stats.bestDistance = Math.max(stats.bestDistance, input.distance);
    stats.bestKills = Math.max(stats.bestKills, input.kills);
    stats.rank = calcRank(stats.totalMeritPoints);

    // プレイ時間帯記録
    const hour = new Date().getHours().toString();
    stats.playHours[hour] = (stats.playHours[hour] ?? 0) + 1;

    // 死亡位置記録（最新100件）
    stats.deathPositions.push(input.distance);
    if (stats.deathPositions.length > 100) {
      stats.deathPositions = stats.deathPositions.slice(-100);
    }

    // 勲章チェック
    const newMedals: string[] = [];
    for (const medalCheck of MEDAL_CHECKS) {
      if (
        !stats.medals.includes(medalCheck.id) &&
        medalCheck.check(input, stats)
      ) {
        stats.medals.push(medalCheck.id);
        newMedals.push(medalCheck.id);
      }
    }

    db.upsertFrontlineStats(stats);

    return { record, stats, newMedals, newBestDistance, newBestKills };
  }
}

export const frontlineManager = new FrontlineManager();
