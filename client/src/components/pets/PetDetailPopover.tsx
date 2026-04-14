// client/src/components/pets/PetDetailPopover.tsx
import type { Pet } from "../../../../shared/types";
import { RARITY_COLORS, SPECIES_INFO } from "../../lib/pet-constants";
import { PetSprite } from "./PetSprite";

interface PetDetailPopoverProps {
  pet: Pet;
  onPet: () => void;
  onFeed: () => void;
  onRename: (name: string) => void;
}

export function PetDetailPopover({
  pet,
  onPet,
  onFeed,
  onRename: _onRename,
}: PetDetailPopoverProps) {
  const info = SPECIES_INFO[pet.species];
  const expToNextLevel = pet.level * 10;
  const expProgress = Math.min(100, (pet.exp / expToNextLevel) * 100);

  return (
    <div className="p-3 space-y-3 min-w-[200px]">
      {/* ヘッダー */}
      <div className="flex items-center gap-3">
        <PetSprite species={pet.species} mood={pet.mood} isActive size={48} />
        <div>
          <div className="font-medium">
            {pet.name ?? info.label}
            <span
              className="ml-1.5 text-[10px] px-1 py-0.5 rounded"
              style={{
                backgroundColor: RARITY_COLORS[info.rarity],
                color: "#fff",
              }}
            >
              {info.rarity}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {info.description}
          </div>
        </div>
      </div>

      {/* ステータス */}
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span>レベル</span>
          <span className="font-mono">{pet.level}</span>
        </div>
        <div>
          <div className="flex justify-between mb-0.5">
            <span>EXP</span>
            <span className="font-mono">
              {pet.exp}/{expToNextLevel}
            </span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${expProgress}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between mb-0.5">
            <span>HP</span>
            <span className="font-mono">{pet.hp}/100</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${pet.hp}%` }}
            />
          </div>
        </div>
        <div className="flex justify-between">
          <span>気分</span>
          <span>
            {pet.mood === "happy" && "😊"}
            {pet.mood === "neutral" && "😐"}
            {pet.mood === "sleepy" && "😴"}
            {pet.mood === "hungry" && "😫"}
            {pet.mood === "sad" && "😢"}
          </span>
        </div>
      </div>

      {/* アクションボタン */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPet}
          className="flex-1 text-xs py-1.5 px-2 rounded bg-pink-500/10 text-pink-500 hover:bg-pink-500/20 transition-colors"
        >
          撫でる 💕
        </button>
        <button
          type="button"
          onClick={onFeed}
          className="flex-1 text-xs py-1.5 px-2 rounded bg-green-500/10 text-green-500 hover:bg-green-500/20 transition-colors"
        >
          エサ 🍖
        </button>
      </div>
    </div>
  );
}
