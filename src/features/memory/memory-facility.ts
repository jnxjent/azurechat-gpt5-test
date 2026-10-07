import type { UserMemory } from "./memory-rules";

// Read the original profile, since the short summary can omit room preferences.
export function profileFacilityPreference(memories: UserMemory[]): string | undefined {
  const rooms = memories.filter(memory => memory.enabled && memory.memoryClass === "profile")
    .flatMap(memory => Array.from(memory.content.matchAll(
      /^\s*(?:[-*]\s*)?(?:優先会議室|既定の会議室|デフォルト会議室)\s*[:：]\s*([^\r\n]+)$/gm,
    ), match => match[1].trim()));
  const unique = Array.from(new Set(rooms)).filter(room => room.length > 0 && room.length <= 120);
  return unique.length === 1 ? unique[0] : undefined;
}
