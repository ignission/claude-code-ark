import { useState } from "react";
import type { Pet, PetAction, PetGame } from "../../../../shared/types";
import { SPECIES_INFO } from "../../lib/pet-constants";
import { GameMenu } from "./GameMenu";
import { PetDetailPopover } from "./PetDetailPopover";
import { PetSprite } from "./PetSprite";

interface ArkPetsPageProps {
  pets: Pet[];
  onInteract: (petId: string, action: PetAction) => void;
  onRename: (petId: string, name: string) => void;
  onGameResult: (petId: string, game: PetGame, score: number) => void;
}

export function ArkPetsPage({
  pets,
  onInteract,
  onRename,
  onGameResult,
}: ArkPetsPageProps) {
  const [selectedPetId, setSelectedPetId] = useState<string | null>(null);
  const [showGame, setShowGame] = useState<{ pet: Pet; game: PetGame } | null>(
    null
  );

  if (pets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <div className="text-4xl">🚢</div>
          <p>まだペットがいません</p>
          <p className="text-xs">セッションを起動するとペットが生まれます</p>
        </div>
      </div>
    );
  }

  const selectedPet = pets.find(p => p.id === selectedPetId);

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-3 space-y-3">
      {/* ペット一覧 */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          ペット ({pets.length})
        </h3>
        <div className="space-y-1">
          {pets.map(pet => {
            const info = SPECIES_INFO[pet.species];
            const isSelected = selectedPetId === pet.id;
            return (
              <button
                key={pet.id}
                type="button"
                onClick={() => setSelectedPetId(isSelected ? null : pet.id)}
                className={`w-full flex items-center gap-2 p-2 rounded-lg transition-colors text-left ${
                  isSelected
                    ? "bg-primary/10 border border-primary/30"
                    : "hover:bg-accent/50 border border-transparent"
                }`}
              >
                <PetSprite
                  species={pet.species}
                  mood={pet.mood}
                  isActive
                  size={24}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {pet.name ?? info.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Lv.{pet.level} · {info.emoji}{" "}
                    {pet.mood === "happy"
                      ? "😊"
                      : pet.mood === "sleepy"
                        ? "😴"
                        : pet.mood === "hungry"
                          ? "😫"
                          : pet.mood === "sad"
                            ? "😢"
                            : "😐"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 選択中ペットの詳細 */}
      {selectedPet && (
        <div className="border border-border rounded-lg">
          <PetDetailPopover
            pet={selectedPet}
            onPet={() => onInteract(selectedPet.id, "pet")}
            onFeed={() => onInteract(selectedPet.id, "feed")}
            onRename={name => onRename(selectedPet.id, name)}
          />
        </div>
      )}

      {/* ゲーム一覧 */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          ミニゲーム
        </h3>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => {
              const pet = selectedPet ?? pets[0];
              setShowGame({ pet, game: "feeding" });
            }}
            className="w-full p-3 rounded-lg border border-border hover:border-primary/30 text-left transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">🍎</span>
              <div>
                <div className="text-sm font-medium">エサキャッチ</div>
                <div className="text-[10px] text-muted-foreground">
                  落ちてくるエサをキャッチ！HP回復+EXP
                </div>
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              const pet = selectedPet ?? pets[0];
              setShowGame({ pet, game: "arkdash" });
            }}
            className="w-full p-3 rounded-lg border border-border hover:border-primary/30 text-left transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">🏃</span>
              <div>
                <div className="text-sm font-medium">箱舟レース</div>
                <div className="text-[10px] text-muted-foreground">
                  障害物を飛び越えろ！距離でEXP獲得
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* ゲームオーバーレイ */}
      {showGame && (
        <GameMenu
          pet={showGame.pet}
          onGameResult={score => {
            onGameResult(showGame.pet.id, showGame.game, score);
            setShowGame(null);
          }}
          onClose={() => setShowGame(null)}
        />
      )}
    </div>
  );
}
