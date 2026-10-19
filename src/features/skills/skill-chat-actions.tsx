"use client";
import { useRef, useState } from "react";
import { useChat } from "@/features/chat-page/chat-store";
import { extractChatSkillDraft, skillChatQuestionProgress } from "./skill-chat-authoring";

export function SkillChatActions(props: {content:string;id?:string}) {
  const {loading,messages} = useChat();
  const [saving,setSaving] = useState(false);
  const [saved,setSaved] = useState(false);
  const [error,setError] = useState("");
  const lock = useRef(false);
  const draft = extractChatSkillDraft(props.content);
  const progress = skillChatQuestionProgress(props.content,messages,props.id);
  async function save() {
    if (!draft||lock.current||saved||loading!=="idle") return;
    lock.current=true;setSaving(true);setError("");
    try {
      const response=await fetch("/api/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(draft)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"保存できませんでした。");setSaved(true);
    } catch(cause) {setError(cause instanceof Error?cause.message:"保存できませんでした。");}
    finally {lock.current=false;setSaving(false);}
  }
  if (!progress&&!draft) return null;
  return <div className="not-prose my-3 space-y-2">
    {progress&&<p aria-label="Skill作成の進捗" className="text-sm font-medium">質問 {progress}</p>}
    {draft&&<div className="flex flex-wrap items-center gap-3"><button type="button" disabled={saving||saved||loading!=="idle"} onClick={()=>void save()} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{saved?"Skillsに保存済み":saving?"保存中…":"Skillsに保存"}</button><a href="/skills" className="text-sm underline">Skillsを開く</a></div>}
    {saved&&<p role="status" className="text-sm">「{draft?.title}」をSkillsに保存しました。</p>}
    {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}
