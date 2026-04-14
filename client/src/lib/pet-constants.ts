// client/src/lib/pet-constants.ts
import type { PetRarity, PetSpecies } from "../../../shared/types";

export const SPECIES_INFO: Record<
  PetSpecies,
  { emoji: string; rarity: PetRarity; label: string; description: string }
> = {
  dog: {
    emoji: "🐕",
    rarity: "common",
    label: "イヌ",
    description: "忠実でセッション稼働を喜ぶ",
  },
  cat: {
    emoji: "🐈",
    rarity: "common",
    label: "ネコ",
    description: "気まぐれで放置に強い",
  },
  rabbit: {
    emoji: "🐇",
    rarity: "common",
    label: "ウサギ",
    description: "素早く短時間で成長",
  },
  bird: {
    emoji: "🐦",
    rarity: "uncommon",
    label: "トリ",
    description: "コミット時に歌う",
  },
  turtle: {
    emoji: "🐢",
    rarity: "uncommon",
    label: "カメ",
    description: "堅実で長時間セッション向き",
  },
  penguin: {
    emoji: "🐧",
    rarity: "uncommon",
    label: "ペンギン",
    description: "仲間好きで並列ブースト",
  },
  fox: {
    emoji: "🦊",
    rarity: "rare",
    label: "キツネ",
    description: "賢くエラー解決でボーナス",
  },
  owl: {
    emoji: "🦉",
    rarity: "rare",
    label: "フクロウ",
    description: "夜行性で深夜ブースト",
  },
};

export const RARITY_COLORS: Record<PetRarity, string> = {
  common: "#9ca3af",
  uncommon: "#22c55e",
  rare: "#eab308",
};

/** 箱舟のアップグレード閾値（ペットレベル合計） */
export const SHIP_TIERS = [
  { minLevel: 0, name: "小舟", emoji: "🛶" },
  { minLevel: 10, name: "帆船", emoji: "⛵" },
  { minLevel: 30, name: "大型船", emoji: "🚢" },
] as const;

export function getShipTier(totalLevel: number) {
  for (let i = SHIP_TIERS.length - 1; i >= 0; i--) {
    if (totalLevel >= SHIP_TIERS[i].minLevel) return SHIP_TIERS[i];
  }
  return SHIP_TIERS[0];
}
