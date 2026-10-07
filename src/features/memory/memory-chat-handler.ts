import "server-only";
import { CreateChatMessage, FindTopChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import { AI_NAME } from "@/features/theme/theme-config";
import { createUserMemory, deleteUserMemory, recordLearnedLesson, renameUserMemory } from "./memory-service";
import { ambiguousMemoryAnswer, answerMemoryCommand, parseMemoryChatCommand } from "./memory-chat";
import { findNamedMemories, memoryKindLabel, requestsMemoryReference } from "./memory-rules";
import type { UserMemory } from "./memory-rules";

export async function handleMemoryChatCommand(props: {
  message: string;
  threadId: string;
  userName: string;
  memories: UserMemory[];
}): Promise<Response | undefined> {
  const { message, threadId, userName, memories } = props;
  let command = parseMemoryChatCommand(message);
  let previousAssistant: string | undefined;
  let previousUser: string | undefined;
  if (command?.kind === "learn" || (command?.kind === "save" || command?.kind === "needs_content") && /(?:この|以下の?|下記の?|上記の?|先ほどの|今の|直前の)(?:内容|回答|手順|説明)/.test(message)) {
    const history = await FindTopChatMessagesForCurrentUser(threadId, 10);
    if (history.status !== "OK") throw new Error("直前の会話を取得できませんでした。再度お試しください。");
    const assistantIndex = history.response.findIndex((item) => item.role === "assistant" && item.content?.trim());
    if (assistantIndex >= 0) {
      previousAssistant = history.response[assistantIndex].content;
      previousUser = history.response.slice(assistantIndex + 1).find((item) => item.role === "user")?.content;
    }
    command = parseMemoryChatCommand(message, previousAssistant);
  }
  let answer: string;
  if (!command) {
    if (!requestsMemoryReference(message)) return undefined;
    const matches = findNamedMemories(memories.filter((item) => item.enabled && item.mode !== "always"), message);
    if (matches.length <= 1) return undefined;
    // A topic can match multiple procedures. Ask for the actual saved name.
    const explicitlyNamed = matches.filter((item) => message.includes(item.title));
    if (explicitlyNamed.length) return undefined;
    answer = ambiguousMemoryAnswer(matches);
  } else {
    try {
      if (command.kind === "save") {
        const saved = await createUserMemory({ title: command.title, content: command.content,
          kind: command.category, mode: command.mode, triggers: command.triggers });
        answer = `「${saved.title}」を保存しました。${memoryKindLabel(saved)}。メモ画面で確認・編集できます。`;
      } else if (command.kind === "learn") {
        const saved = await recordLearnedLesson({ feedback: command.feedback, threadId, previousAssistant, previousUser });
        answer = `LearnedLessonを記録しました。\n- 詳細・再確認手順: メモ「${saved.detail.title}」\n- 共通注意: メモ「${saved.memo.title}」（${saved.memo.enabled ? "毎回参照" : "現在は無効"}）\n原因は未確認として記録しています。「${saved.detail.title}」のメモを参照して、と指定すると詳細を参照します。`;
      } else if (command.kind === "rename" || command.kind === "delete") {
        const matches = findNamedMemories(memories, command.query);
        if (matches.length === 0) answer = "該当するメモが見つかりませんでした。";
        else if (matches.length > 1) answer = ambiguousMemoryAnswer(matches);
        else if (command.kind === "rename") {
          const renamed = await renameUserMemory(matches[0], command.title);
          answer = `「${matches[0].title}」の保存名を「${renamed.title}」に変更しました。`;
        } else {
          await deleteUserMemory(matches[0].id);
          answer = `「${matches[0].title}」を削除しました。以後参照しません。`;
        }
      } else answer = answerMemoryCommand(command, memories);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      answer = `保存・変更できませんでした。${error.message}`;
    }
  }
  await CreateChatMessage({ name: userName, content: message, role: "user", chatThreadId: threadId });
  await CreateChatMessage({ name: AI_NAME, content: answer, role: "assistant", chatThreadId: threadId });
  const event = JSON.stringify({ type: "finalContent", response: answer });
  return new Response(`event: finalContent\ndata: ${event}\n\n`, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export async function createMemoryRelevanceConfirmation(props: {
  message: string;
  threadId: string;
  userName: string;
  memory: UserMemory;
  evidence: string;
}): Promise<Response> {
  const evidence = props.evidence.replace(/\s+/g, " ").slice(0, 180);
  const answer = `メモ「${props.memory.title}」には「${evidence}」と記載があります。今回の場合もこのメモを適用するべきですか？（はい／いいえ）`;
  await CreateChatMessage({ name: props.userName, content: props.message, role: "user", chatThreadId: props.threadId });
  await CreateChatMessage({ name: AI_NAME, content: answer, role: "assistant", chatThreadId: props.threadId });
  const event = JSON.stringify({ type: "finalContent", response: answer });
  return new Response(`event: finalContent\ndata: ${event}\n\n`, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
