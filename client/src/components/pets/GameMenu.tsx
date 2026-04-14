// client/src/components/pets/GameMenu.tsx
import { useState } from "react";
import type { Pet, PetGame } from "../../../../shared/types";
import { ArkDashGame } from "./ArkDashGame";
import { FeedingGame } from "./FeedingGame";

interface GameMenuProps {
  pet: Pet;
  onGameResult: (score: number) => void;
  onClose: () => void;
}

export function GameMenu({ pet, onGameResult, onClose }: GameMenuProps) {
  const [activeGame, setActiveGame] = useState<PetGame | null>(null);

  if (activeGame === "feeding") {
    return (
      <div className="fixed inset-0 z-50 bg-background/95 flex flex-col items-center justify-center p-4">
        <FeedingGame
          pet={pet}
          onFinish={score => {
            onGameResult(score);
            setActiveGame(null);
          }}
        />
      </div>
    );
  }

  if (activeGame === "arkdash") {
    return (
      <div className="fixed inset-0 z-50 bg-background/95 flex flex-col items-center justify-center p-4">
        <ArkDashGame
          pet={pet}
          onFinish={score => {
            onGameResult(score);
            setActiveGame(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center p-4">
      <div className="bg-background border border-border rounded-xl p-6 space-y-4 max-w-sm w-full">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-bold">🎮 ミニゲーム</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setActiveGame("feeding")}
            className="w-full p-4 rounded-lg border border-border hover:border-primary/50 text-left transition-colors"
          >
            <div className="font-medium">🍎 エサキャッチ</div>
            <div className="text-xs text-muted-foreground mt-1">
              落ちてくるエサをキャッチ！HP回復 + EXP獲得
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveGame("arkdash")}
            className="w-full p-4 rounded-lg border border-border hover:border-primary/50 text-left transition-colors"
          >
            <div className="font-medium">🏃 箱舟レース</div>
            <div className="text-xs text-muted-foreground mt-1">
              障害物を飛び越えろ！距離に応じてEXP獲得
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
