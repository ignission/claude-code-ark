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

export function usePets(socket: ArkSocket | null, isConnected: boolean) {
  const [pets, setPets] = useState<Pet[]>([]);

  // リスナー登録（socketオブジェクトが変わった時のみ）
  useEffect(() => {
    if (!socket) return;

    const handleList = (data: Pet[]) => setPets(data);
    const handleCreated = (pet: Pet) => setPets(prev => [...prev, pet]);
    const handleUpdated = (pet: Pet) =>
      setPets(prev => prev.map(p => (p.id === pet.id ? pet : p)));
    const handleDeleted = ({ petId }: { petId: string }) => {
      setPets(prev => prev.filter(p => p.id !== petId));
    };
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
    socket.on("pet:deleted", handleDeleted);
    socket.on("pet:level_up", handleLevelUp);

    return () => {
      socket.off("pet:list", handleList);
      socket.off("pet:created", handleCreated);
      socket.off("pet:updated", handleUpdated);
      socket.off("pet:deleted", handleDeleted);
      socket.off("pet:level_up", handleLevelUp);
    };
  }, [socket]);

  // 接続確立後にペット一覧を要求
  useEffect(() => {
    if (!socket || !isConnected) return;
    socket.emit("pet:list");
  }, [socket, isConnected]);

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
