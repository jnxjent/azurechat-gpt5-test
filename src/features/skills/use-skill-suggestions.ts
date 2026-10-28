"use client";
import { useEffect, useState } from "react";
import { applySkillSuggestion, skillSuggestionKey, suggestSkills, type SkillSuggestion } from "./skill-suggestions";

export function useSkillSuggestions(draft: string, thread: string, enabled: boolean, onSelect: (value: string) => void, catalogOwner = "", catalogAllowed = true) {
  const [skills, setSkills] = useState<SkillSuggestion[]>([]);
  const [dismissed, setDismissed] = useState<string>();
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState<{skill: SkillSuggestion; prefix: string}>();
  useEffect(() => {
    let controller: AbortController | undefined;
    setSkills([]);
    setSelection(undefined); setDismissed(undefined); setActive(0);
    if (!catalogAllowed) return;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController(); controller = request;
      fetch("/api/skills/suggestions", { cache: "no-store", signal: request.signal })
      .then(async r => r.ok ? r.json() : { items: [] })
      .then(result => { if (!request.signal.aborted && Array.isArray(result.items)) setSkills(result.items); })
      .catch(() => { if (!request.signal.aborted) setSkills([]); });
    };
    const storage = (event: StorageEvent) => { if (event.key === "azurechat:skills-changed") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("azurechat:skills-changed", refresh);
    window.addEventListener("storage", storage);
    return () => { controller?.abort(); window.removeEventListener("focus", refresh); window.removeEventListener("azurechat:skills-changed", refresh); window.removeEventListener("storage", storage); };
  }, [thread, catalogOwner, catalogAllowed]);
  const candidates = catalogAllowed && enabled && !composing && dismissed !== draft ? suggestSkills(skills, draft) : [];
  const candidateIds = candidates.map(skill => skill.id).join(",");
  useEffect(() => { setActive(0); }, [draft, candidateIds]);
  const activeIndex = Math.max(0, Math.min(active, candidates.length - 1));
  const selectedSkill = catalogAllowed && selection && draft.startsWith(selection.prefix) ? selection.skill : undefined;
  const select = (skill: SkillSuggestion) => {
    const value = applySkillSuggestion(draft, skill);
    setSelection({skill,prefix:applySkillSuggestion("",skill)}); onSelect(value);
  };
  return { candidates, activeIndex, select, selectedSkill, clearSelection: () => {
    if (selection && selectedSkill) onSelect(draft.slice(selection.prefix.length));
    setSelection(undefined);
  }, setComposing, onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = skillSuggestionKey(event.key, event.shiftKey, composing || event.nativeEvent.isComposing || event.keyCode === 229, candidates.length > 0);
    if (!action || event.ctrlKey || event.altKey || event.metaKey) return false;
    event.preventDefault();
    if (action === "accept") select(candidates[activeIndex]);
    else if (action === "next") setActive((activeIndex + 1) % candidates.length);
    else if (action === "previous") setActive((activeIndex + candidates.length - 1) % candidates.length);
    else setDismissed(draft);
    return true;
  } };
}
