import type { TeamsSkillReply } from "./teams-skill-service";

// Reserve room for Teams' activity envelope, entities and continuation labels.
export const TEAMS_SKILL_TEXT_BYTES = 20_000;
const fits = (text: string) => Buffer.byteLength(JSON.stringify({type:"message",text}),"utf8") <= TEAMS_SKILL_TEXT_BYTES;
export function splitTeamsSkillText(text: string): string[] {
  const lines=text.replace(/\r\n/g,"\n").split("\n");
  const units:string[]=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      const fence=line.trim().slice(0,3); const block=[line];
      while(++i<lines.length){block.push(lines[i]);if(lines[i].trim().startsWith(fence))break;}
      units.push(block.join("\n")); continue;
    }
    if (i+1<lines.length && line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {
      const header=line+"\n"+lines[++i]; let table=header;
      while(i+1<lines.length && lines[i+1].includes("|") && lines[i+1].trim()) {
        const row=lines[++i];
        if(!fits(header+"\n"+row+"\n（続き 999/999）"))throw Error("teams_skill_line_too_large");
        if(!fits(table+"\n"+row+"\n（続き 999/999）")){units.push(table);table=header;}
        table+="\n"+row;
      }
      units.push(table); continue;
    }
    units.push(line);
  }
  const parts:string[]=[];let current="";
  for(const unit of units){
    if(!fits(unit+"\n（続き 999/999）"))throw Error("teams_skill_line_too_large");
    const next=current?current+"\n"+unit:unit;
    if(!fits(next+"\n（続き 999/999）")){parts.push(current);current=unit;}else current=next;
  }
  if(current)parts.push(current);
  if(parts.length>50)throw Error("teams_skill_report_too_large");
  return parts.length>1?parts.map((part,i)=>`（${i+1}/${parts.length}）\n${part}`):parts;
}
export async function deliverTeamsSkillReply(reply: TeamsSkillReply | undefined, send:(value:any)=>Promise<unknown>, onPart?:()=>Promise<void>) {
  if(!reply?.text&&!reply?.card)throw Error("teams_skill_empty_reply");
  // Validate all splits before sending any text: no broken links or chopped rows.
  const parts=reply?.text?splitTeamsSkillText(reply.text):[];
  for(const text of parts){await send(text);await onPart?.();}
  if(reply?.card){
    console.info("[teams-skill] card",{kind:reply.cardKind??"unknown",version:reply.card.version});
    await send({type:"message",text:"スキルの選択・確認カードです。カードを表示できない場合はTeamsのWeb版またはデスクトップ版で開いてください。",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:reply.card}]});
    await onPart?.();
  }
}
