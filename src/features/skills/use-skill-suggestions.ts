"use client";
import { useEffect, useState } from "react";
import { applySkillSuggestion, skillSuggestionKey, suggestSkills, type SkillSuggestion } from "./skill-suggestions";

export function useSkillSuggestions(draft: string, thread: string, enabled: boolean, onSelect: (value: string) => void) {
  const [skills, setSkills] = useState<SkillSuggestion[]>([]);
  const [dismissed, setDismissed] = useState<string>();
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setSkills([]);
    fetch("/api/skills/suggestions", { cache: "no-store", signal: controller.signal })
      .then(async r => r.ok ? r.json() : { items: [] })
      .then(result => { if (!controller.signal.aborted && Array.isArray(result.items)) setSkills(result.items); })
      .catch(() => { /* Suggestions are optional; ordinary chat remains available. */ });
    return () => controller.abort();
  }, [thread]);
  const candidates = enabled && !composing && dismissed !== draft ? suggestSkills(skills, draft) : [];
  const select = (skill: SkillSuggestion) => onSelect(applySkillSuggestion(draft, skill));
  return { candidates, select, setComposing, onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = skillSuggestionKey(event.key, event.shiftKey, composing || event.nativeEvent.isComposing || event.keyCode === 229, candidates.length > 0);
    if (!action || event.ctrlKey || event.altKey || event.metaKey) return false;
    event.preventDefault();
    if (action === "accept") select(candidates[0]);
    else setDismissed(draft);
    return true;
  } };
}
