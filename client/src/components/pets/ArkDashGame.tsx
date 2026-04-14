// client/src/components/pets/ArkDashGame.tsx
import { useCallback, useRef, useState } from "react";
import type { Pet } from "../../../../shared/types";
import { useGameLoop } from "../../hooks/useGameLoop";
import { drawSprite } from "../../lib/pet-sprites";

interface ArkDashGameProps {
  pet: Pet;
  onFinish: (score: number) => void;
}

interface Obstacle {
  x: number;
  width: number;
  height: number;
}

const CANVAS_W = 320;
const CANVAS_H = 180;
const GROUND_Y = 140;
const GRAVITY = 0.4;
const JUMP_FORCE = -8;
const GAME_SPEED_BASE = 3;

/** 種別ごとのジャンプ力倍率 */
const SPECIES_JUMP: Record<string, number> = {
  dog: 1.0,
  cat: 1.1,
  rabbit: 1.2,
  bird: 1.4,
  turtle: 1.3,
  penguin: 1.0,
  fox: 1.1,
  owl: 1.4,
};

export function ArkDashGame({ pet, onFinish }: ArkDashGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [distance, setDistance] = useState(0);
  const [running, setRunning] = useState(true);
  const [gameOver, setGameOver] = useState(false);

  const petYRef = useRef(GROUND_Y - 32);
  const velYRef = useRef(0);
  const isJumpingRef = useRef(false);
  const obstaclesRef = useRef<Obstacle[]>([]);
  const distanceRef = useRef(0);
  const spawnTimerRef = useRef(0);
  const speedRef = useRef(GAME_SPEED_BASE);

  const jumpMultiplier = SPECIES_JUMP[pet.species] ?? 1.0;

  const jump = useCallback(() => {
    if (!isJumpingRef.current) {
      velYRef.current = JUMP_FORCE * jumpMultiplier;
      isJumpingRef.current = true;
    }
  }, [jumpMultiplier]);

  useGameLoop(delta => {
    if (!running) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dt = delta / 16;

    // ペット物理
    velYRef.current += GRAVITY * dt;
    petYRef.current += velYRef.current * dt;
    if (petYRef.current >= GROUND_Y - 32) {
      petYRef.current = GROUND_Y - 32;
      velYRef.current = 0;
      isJumpingRef.current = false;
    }

    // 速度増加
    speedRef.current = GAME_SPEED_BASE + distanceRef.current / 500;

    // 障害物生成
    spawnTimerRef.current -= speedRef.current * dt;
    if (spawnTimerRef.current <= 0) {
      obstaclesRef.current.push({
        x: CANVAS_W,
        width: 12 + Math.random() * 12,
        height: 16 + Math.random() * 20,
      });
      spawnTimerRef.current = 80 + Math.random() * 60;
    }

    // 距離
    distanceRef.current += speedRef.current * dt;
    setDistance(Math.floor(distanceRef.current));

    // 描画
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 空
    ctx.fillStyle = "#0c1222";
    ctx.fillRect(0, 0, CANVAS_W, GROUND_Y);

    // 地面
    ctx.fillStyle = "#3f3f46";
    ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);

    // ペット
    const spriteState = isJumpingRef.current ? "idle" : "walk";
    drawSprite(ctx, pet.species, spriteState, 40, petYRef.current, 4);

    // 障害物
    ctx.fillStyle = "#ef4444";
    obstaclesRef.current = obstaclesRef.current.filter(obs => {
      obs.x -= speedRef.current * dt;
      if (obs.x + obs.width < 0) return false;

      ctx.fillRect(obs.x, GROUND_Y - obs.height, obs.width, obs.height);

      // 当たり判定
      const petLeft = 40;
      const petRight = 40 + 32;
      const petBottom = petYRef.current + 32;
      if (
        petRight > obs.x &&
        petLeft < obs.x + obs.width &&
        petBottom > GROUND_Y - obs.height
      ) {
        setRunning(false);
        setGameOver(true);
        return false;
      }
      return true;
    });
  }, running);

  const handleInput = useCallback(() => {
    if (gameOver) {
      onFinish(Math.floor(distanceRef.current));
    } else {
      jump();
    }
  }, [gameOver, jump, onFinish]);

  if (gameOver && !running) {
    return (
      <div className="flex flex-col items-center gap-4 p-4">
        <div className="text-2xl font-bold">💥 ゲームオーバー</div>
        <div className="text-4xl font-mono">{distance}m</div>
        <button
          type="button"
          onClick={() => onFinish(distance)}
          className="px-4 py-2 rounded bg-primary text-primary-foreground"
        >
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-full text-sm px-2 text-right font-mono">
        {distance}m
      </div>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onClick={handleInput}
        onKeyDown={e => {
          if (e.code === "Space") {
            e.preventDefault();
            handleInput();
          }
        }}
        tabIndex={0}
        className="rounded-lg border border-border cursor-pointer outline-none"
        style={{
          imageRendering: "pixelated",
          width: "100%",
          maxWidth: CANVAS_W,
        }}
      />
      <p className="text-xs text-muted-foreground">
        タップ or スペースキーでジャンプ
      </p>
    </div>
  );
}
