import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import {
  listCharacters,
  removeCharacter,
  saveCharacter,
  setActiveCharacter,
  type EveCharacter,
  type LoginResult,
} from "../lib/db";

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export const CHARACTERS_KEY = ["characters"] as const;

/**
 * EVE 角色状态。数据用 TanStack Query 缓存，
 * 授权 / 切换 / 解绑都是 mutation，成功后 invalidate 列表。
 */
export function useCharacters() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: CHARACTERS_KEY,
    queryFn: () => listCharacters(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: CHARACTERS_KEY });

  const loginMutation = useMutation({
    mutationFn: async () => {
      const result = await invoke<LoginResult>("eve_login");
      await saveCharacter(result);
      return result;
    },
    onSuccess: invalidate,
  });

  const switchMutation = useMutation({
    mutationFn: (characterId: number) => setActiveCharacter(characterId),
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (characterId: number) => removeCharacter(characterId),
    onSuccess: invalidate,
  });

  const characters: EveCharacter[] = query.data ?? [];
  const activeCharacter =
    characters.find((item) => item.is_active === 1) ?? characters[0] ?? null;

  const firstError =
    loginMutation.error ?? switchMutation.error ?? removeMutation.error ?? null;

  return {
    characters,
    activeCharacter,
    loading: query.isPending,
    loadError: query.error ? describeError(query.error) : null,
    authorizing: loginMutation.isPending,
    actionError: firstError ? describeError(firstError) : null,
    refresh: () => query.refetch(),
    login: () => loginMutation.mutateAsync(),
    switchTo: (characterId: number) => switchMutation.mutateAsync(characterId),
    remove: (characterId: number) => removeMutation.mutateAsync(characterId),
    clearActionError: () => {
      loginMutation.reset();
      switchMutation.reset();
      removeMutation.reset();
    },
  };
}
