import "server-only";
import { CreateChatMessage, FindTopChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import { AI_NAME } from "@/features/theme/theme-config";
import { createUserSkill, deleteUserSkill, listUserSkills, listAvailableSkills, updateUserSkill } from "./skill-service";
import { formatSkillContext, namedSkills, requestsSkillReference, selectSkills, skillName } from "./skill-rules";
import type { UserSkill } from "./skill-rules";
import { parseSkillCommand } from "./skill-chat";

export async function prepareSkillsForChat(props: {message:string;threadId:string;userName:string;skillId?:string;skillVersion?:number}): Promise<{response?:Response;selected:UserSkill[]}> {
  let command = parseSkillCommand(props.message);
  if (!command && !props.skillId && !requestsSkillReference(props.message)) return {selected:[]};
  const skills = command ? await listUserSkills() : await listAvailableSkills();
  let answer: string | undefined;
  if (command?.kind === "needs_content" && /この回答|この内容|今の回答|今の説明|直前の回答|直前の説明|これを/.test(props.message.split("\n")[0])) {
    const history = await FindTopChatMessagesForCurrentUser(props.threadId,10);
    if (history.status !== "OK") throw new Error("直前の回答を取得できませんでした。");
    command = parseSkillCommand(props.message, history.response.find(item => item.role === "assistant" && item.content?.trim())?.content);
  }
  try {
    if (!command) {
      const selected = props.skillId ? skills.filter(skill => skill.id === props.skillId && skill.enabled && Number.isSafeInteger(props.skillVersion) && skill.version === props.skillVersion) : selectSkills(skills, props.message);
      if (props.skillId && !selected.length) throw new TypeError("選択したSkillが変更・非公開・無効化されています。候補を選び直してください。");
      if (!props.skillId && new Set(selected.map(skill => skillName(skill.title))).size !== selected.length) throw new TypeError("同じ名前のSkillが複数あります。入力欄の候補から作成者を確認して選んでください。");
      formatSkillContext(selected); // Reject excessive input before starting a model run.
      if (selected.length || !/skills?|スキル/i.test(props.message)) return {selected};
      answer = "呼び出すSkillが見つからないか、無効になっています。Skills画面で名前を確認し、「Skill『保存名』を使って…」と指定してください。";
    } else if (command.kind === "list") {
      answer = skills.length ? `保存済みのSkills:\n${skills.map(skill => `- ${skill.title} v${skill.version}${skill.enabled ? "" : "（無効）"}`).join("\n")}` : "保存済みのSkillはありません。左メニューのSkillsから作成できます。";
    } else if (command.kind === "needs_name") answer = "保存名を「」で指定してください。例：以下を「取引先情報」のSkillとして保存して、の次の行にプロンプト本文を入力します。";
    else if (command.kind === "needs_content") answer = "保存の指示の次の行にプロンプト本文を入力してください。直前の回答を保存する場合は、この回答を「保存名」のSkillとして保存して、と指定してください。";
    else if (command.kind === "save") {
      const saved = await createUserSkill({title:command.title,content:command.content});
      answer = `Skill「${saved.title}」を保存しました。左メニューのSkillsから確認・編集・skill.mdのダウンロードができます。`;
    } else {
      const matches = namedSkills(skills,command.query);
      if (matches.length !== 1) answer = matches.length ? "複数のSkillが見つかりました。保存名を正確に指定してください。" : "Skillが見つかりませんでした。";
      else if (command.kind === "show") answer = `Skill「${matches[0].title}」v${matches[0].version}\n\n${matches[0].content}`;
      else if (command.kind === "delete") { await deleteUserSkill(matches[0].id,matches[0].version); answer=`Skill「${matches[0].title}」を削除しました。`; }
      else if (command.kind === "rename") { const saved=await updateUserSkill(matches[0].id,{...matches[0],title:command.title},matches[0].version); answer=`Skillの名前を「${saved.title}」に変更しました。`; }
    }
  } catch(error) { if (!(error instanceof TypeError)) throw error; answer=error.message; }
  await CreateChatMessage({name:props.userName,content:props.message,role:"user",chatThreadId:props.threadId});
  await CreateChatMessage({name:AI_NAME,content:answer!,role:"assistant",chatThreadId:props.threadId});
  return {selected:[],response:new Response(`event: finalContent\ndata: ${JSON.stringify({type:"finalContent",response:answer})}\n\n`,{
    headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache"},
  })};
}
