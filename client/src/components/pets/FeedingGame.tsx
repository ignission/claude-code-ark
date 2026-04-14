// client/src/components/pets/FeedingGame.tsx
import { useCallback, useRef, useState } from "react";
import type { Pet } from "../../../../shared/types";
import { useGameLoop } from "../../hooks/useGameLoop";
import { drawSprite } from "../../lib/pet-sprites";

interface FeedingGameProps {
  pet: Pet;
  onFinish: (score: number) => void;
}

interface FallingFood {
  x: number;
  y: number;
  emoji: string;
  speed: number;
}

const FOODS = ["🍎", "🍖", "🐟", "🥕", "🍪"];
const GAME_DURATION_MS = 30_000;
const CANVAS_W = 280;
const CANVAS_H = 320;

export function FeedingGame({ pet, onFinish }: FeedingGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_MS);
  const [running, setRunning] = useState(true);

  const petXRef = useRef(CANVAS_W / 2 - 16);
  const foodsRef = useRef<FallingFood[]>([]);
  const scoreRef = useRef(0);
  const spawnTimerRef = useRef(0);
  const gameTimerRef = useRef(GAME_DURATION_MS);

  const spawnFood = useCallback(() => {
    foodsRef.current.push({
      x: Math.random() * (CANVAS_W - 20),
      y: -20,
      emoji: FOODS[Math.floor(Math.random() * FOODS.length)],
      speed: 1.5 + Math.random() * 1.5,
    });
  }, []);

  useGameLoop(delta => {
    if (!running) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // タイマー更新
    gameTimerRef.current -= delta;
    if (gameTimerRef.current <= 0) {
      setRunning(false);
      onFinish(scoreRef.current);
      return;
    }
    setTimeLeft(gameTimerRef.current);

    // エサ生成
    spawnTimerRef.current -= delta;
    if (spawnTimerRef.current <= 0) {
      spawnFood();
      spawnTimerRef.current = 600 + Math.random() * 400;
    }

    // 描画
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 背景
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // ペット描画
    const petX = petXRef.current;
    const petY = CANVAS_H - 40;
    drawSprite(ctx, pet.species, "idle", petX, petY, 4);

    // エサ描画・移動・当たり判定
    const catchRadius = 28;
    foodsRef.current = foodsRef.current.filter(food => {
      food.y += food.speed * (delta / 16);

      // 当たり判定
      if (
        food.y + 16 >= petY &&
        food.x >= petX - catchRadius &&
        food.x <= petX + catchRadius
      ) {
        scoreRef.current += 1;
        setScore(scoreRef.current);
        return false;
      }

      // 画面外
      if (food.y > CANVAS_H) return false;

      // 描画
      ctx.font = "16px serif";
      ctx.fillText(food.emoji, food.x, food.y);
      return true;
    });
  }, running);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      petXRef.current = Math.max(
        0,
        Math.min(CANVAS_W - 32, (e.clientX - rect.left) * scaleX - 16)
      );
    },
    []
  );

  if (!running) {
    return (
      <div className="flex flex-col items-center gap-4 p-4">
        <div className="text-2xl font-bold">🎉 結果</div>
        <div className="text-4xl font-mono">{score} 個キャッチ!</div>
        <button
          type="button"
          onClick={() => onFinish(score)}
          className="px-4 py-2 rounded bg-primary text-primary-foreground"
        >
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex justify-between w-full text-sm px-2">
        <span>スコア: {score}</span>
        <span>残り: {Math.ceil(timeLeft / 1000)}秒</span>
      </div>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onPointerMove={handlePointerMove}
        className="rounded-lg border border-border cursor-none touch-none"
        style={{
          imageRendering: "pixelated",
          width: "100%",
          maxWidth: CANVAS_W,
        }}
      />
    </div>
  );
}
