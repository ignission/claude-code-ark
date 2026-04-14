// client/src/hooks/usePets.ts
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  Pet,
  PetAction,
  PetGame,
  ServerToClientEvents,
} from "../../../shared/types";

type ArkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function usePets(socket: ArkSocket | null) {
  const [pets, setPets] = useState<Pet[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handleList = (data: Pet[]) => setPets(data);
    const handleCreated = (pet: Pet) => setPets(prev => [...prev, pet]);
    const handleUpdated = (pet: Pet) =>
      setPets(prev => prev.map(p => (p.id === pet.id ? pet : p)));
    const handleLevelUp = ({
      petId,
      newLevel,
    }: {
      petId: string;
      newLevel: number;
    }) => {
      setPets(prev =>
        prev.map(p => (p.id === petId ? { ...p, level: newLevel } : p))
      );
    };

    socket.on("pet:list", handleList);
    socket.on("pet:created", handleCreated);
    socket.on("pet:updated", handleUpdated);
    socket.on("pet:level_up", handleLevelUp);

    // 初回ロード
    socket.emit("pet:list");

    return () => {
      socket.off("pet:list", handleList);
      socket.off("pet:created", handleCreated);
      socket.off("pet:updated", handleUpdated);
      socket.off("pet:level_up", handleLevelUp);
    };
  }, [socket]);

  const interactWithPet = useCallback(
    (petId: string, action: PetAction) => {
      socket?.emit("pet:interact", { petId, action });
    },
    [socket]
  );

  const renamePet = useCallback(
    (petId: string, name: string) => {
      socket?.emit("pet:rename", { petId, name });
    },
    [socket]
  );

  const submitGameResult = useCallback(
    (petId: string, game: PetGame, score: number) => {
      socket?.emit("pet:game_result", { petId, game, score });
    },
    [socket]
  );

  const getPetForSession = useCallback(
    (sessionId: string) => pets.find(p => p.sessionId === sessionId),
    [pets]
  );

  const totalLevel = pets.reduce((sum, p) => sum + p.level, 0);

  return {
    pets,
    totalLevel,
    interactWithPet,
    renamePet,
    submitGameResult,
    getPetForSession,
  };
}
