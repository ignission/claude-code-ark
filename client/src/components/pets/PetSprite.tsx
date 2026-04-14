// client/src/components/pets/PetSprite.tsx
import { useCallback, useEffect, useRef } from "react";
import type { PetMood, PetSpecies } from "../../../../shared/types";
import {
  drawSprite,
  getSpriteState,
  SPRITE_GRID_SIZE,
} from "../../lib/pet-sprites";

interface PetSpriteProps {
  species: PetSpecies;
  mood: PetMood;
  isActive: boolean;
  size?: number;
  onClick?: () => void;
}

export function PetSprite({
  species,
  mood,
  isActive,
  size = 24,
  onClick,
}: PetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  const pixelSize = Math.floor(size / SPRITE_GRID_SIZE);
  const canvasSize = pixelSize * SPRITE_GRID_SIZE;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasSize, canvasSize);
    const state = getSpriteState(mood, isActive);

    // 歩行アニメはフレーム交互
    const animState =
      state === "walk" && frameRef.current % 2 === 1 ? "idle" : state;
    drawSprite(ctx, species, animState, 0, 0, pixelSize);
  }, [species, mood, isActive, pixelSize, canvasSize]);

  useEffect(() => {
    draw();

    // アニメーションループ（500msごとにフレーム切り替え）
    const interval = setInterval(() => {
      frameRef.current += 1;
      draw();
    }, 500);

    return () => clearInterval(interval);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize}
      height={canvasSize}
      onClick={onClick}
      className={onClick ? "cursor-pointer" : ""}
      style={{
        width: size,
        height: size,
        imageRendering: "pixelated",
      }}
    />
  );
}
