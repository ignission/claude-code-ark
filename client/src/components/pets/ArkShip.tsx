// client/src/components/pets/ArkShip.tsx
import { useCallback, useEffect, useRef } from "react";
import type { Pet } from "../../../../shared/types";
import { getShipTier } from "../../lib/pet-constants";
import {
  drawSprite,
  getSpriteState,
  SPRITE_GRID_SIZE,
} from "../../lib/pet-sprites";

interface ArkShipProps {
  pets: Pet[];
  totalLevel: number;
  onPetClick: (pet: Pet) => void;
}

interface PetPosition {
  petId: string;
  x: number;
  y: number;
  dx: number;
  targetX: number;
}

const PIXEL_SIZE = 4;
const CANVAS_W = 320;
const CANVAS_H = 240;
const DECK_Y = 140;
const DECK_MIN_X = 40;
const DECK_MAX_X = 260;

export function ArkShip({ pets, totalLevel, onPetClick }: ArkShipProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef<Map<string, PetPosition>>(new Map());
  const animFrameRef = useRef<number>(0);
  const frameCountRef = useRef(0);

  const shipTier = getShipTier(totalLevel);

  // ペットの位置を初期化・更新
  useEffect(() => {
    const positions = positionsRef.current;
    for (const pet of pets) {
      if (!positions.has(pet.id)) {
        const x = DECK_MIN_X + Math.random() * (DECK_MAX_X - DECK_MIN_X);
        positions.set(pet.id, {
          petId: pet.id,
          x,
          y: DECK_Y - SPRITE_GRID_SIZE * PIXEL_SIZE,
          dx: Math.random() > 0.5 ? 0.3 : -0.3,
          targetX: DECK_MIN_X + Math.random() * (DECK_MAX_X - DECK_MIN_X),
        });
      }
    }
    // 削除されたペットの位置を削除
    const petIds = new Set(pets.map(p => p.id));
    for (const key of positions.keys()) {
      if (!petIds.has(key)) positions.delete(key);
    }
  }, [pets]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 海
    ctx.fillStyle = "#1e3a5f";
    ctx.fillRect(0, CANVAS_H - 60, CANVAS_W, 60);

    // 波
    ctx.fillStyle = "#2563eb";
    for (let x = 0; x < CANVAS_W; x += 16) {
      const waveY =
        CANVAS_H - 60 + Math.sin((x + frameCountRef.current * 2) / 20) * 3;
      ctx.fillRect(x, waveY, 12, 3);
    }

    // 箱舟の船体
    ctx.fillStyle = "#8B4513";
    ctx.beginPath();
    ctx.moveTo(20, DECK_Y);
    ctx.lineTo(300, DECK_Y);
    ctx.lineTo(280, CANVAS_H - 60);
    ctx.lineTo(40, CANVAS_H - 60);
    ctx.closePath();
    ctx.fill();

    // 甲板
    ctx.fillStyle = "#D2691E";
    ctx.fillRect(30, DECK_Y - 4, 260, 4);

    // マスト（帆船以上）
    if (shipTier.minLevel >= 10) {
      ctx.fillStyle = "#5C3317";
      ctx.fillRect(155, DECK_Y - 80, 4, 80);
      ctx.fillStyle = "#FFF";
      ctx.fillRect(130, DECK_Y - 75, 30, 40);
    }

    // 旗（大型船）
    if (shipTier.minLevel >= 30) {
      ctx.fillStyle = "#EF4444";
      ctx.fillRect(157, DECK_Y - 85, 20, 12);
    }

    // ペットを描画
    const positions = positionsRef.current;
    for (const pet of pets) {
      const pos = positions.get(pet.id);
      if (!pos) continue;

      // 移動（簡易AI）
      if (Math.abs(pos.x - pos.targetX) < 2) {
        pos.targetX = DECK_MIN_X + Math.random() * (DECK_MAX_X - DECK_MIN_X);
        pos.dx = pos.x < pos.targetX ? 0.3 : -0.3;
      }
      pos.x += pos.dx;
      pos.x = Math.max(DECK_MIN_X, Math.min(DECK_MAX_X, pos.x));

      const state = getSpriteState(pet.mood, true);
      const animState =
        state === "walk" && frameCountRef.current % 2 === 1 ? "idle" : state;
      drawSprite(ctx, pet.species, animState, pos.x, pos.y, PIXEL_SIZE);
    }

    frameCountRef.current += 1;
    animFrameRef.current = requestAnimationFrame(draw);
  }, [pets, shipTier]);

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [draw]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      const scaleY = CANVAS_H / rect.height;
      const clickX = (e.clientX - rect.left) * scaleX;
      const clickY = (e.clientY - rect.top) * scaleY;

      const spriteSize = SPRITE_GRID_SIZE * PIXEL_SIZE;
      for (const pet of pets) {
        const pos = positionsRef.current.get(pet.id);
        if (!pos) continue;
        if (
          clickX >= pos.x &&
          clickX <= pos.x + spriteSize &&
          clickY >= pos.y &&
          clickY <= pos.y + spriteSize
        ) {
          onPetClick(pet);
          return;
        }
      }
    },
    [pets, onPetClick]
  );

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onClick={handleCanvasClick}
        className="w-full cursor-pointer rounded-lg border border-border"
        style={{
          imageRendering: "pixelated",
          aspectRatio: `${CANVAS_W}/${CANVAS_H}`,
        }}
      />
      <div className="absolute top-2 left-2 text-xs bg-background/80 px-2 py-1 rounded">
        {shipTier.emoji} {shipTier.name}（合計Lv.{totalLevel}）
      </div>
    </div>
  );
}
