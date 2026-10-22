"use client";
import { ChatInput } from "@/features/chat-page/chat-input/chat-input";
import { DeskNetsCredentialRegistration } from "@/features/desknets-agent/desknets-credential-registration";
import { chatStore, useChat } from "@/features/chat-page/chat-store";
import { ChatLoading } from "@/features/ui/chat/chat-message-area/chat-loading";
import { ChatMessageArea } from "@/features/ui/chat/chat-message-area/chat-message-area";
import ChatMessageContainer from "@/features/ui/chat/chat-message-area/chat-message-container";
import ChatMessageContentArea from "@/features/ui/chat/chat-message-area/chat-message-content";
import { useChatScrollAnchor } from "@/features/ui/chat/chat-message-area/use-chat-scroll-anchor";
import { Download } from "lucide-react";
import { useSession } from "next-auth/react";
import { FC, useEffect, useRef, useState } from "react";
import { CanvasPanel } from "@/features/canvas/canvas-panel";
import { canvasChatContext } from "@/features/canvas/canvas-rules";
import { salesforcePresentationRequest } from "@/features/common/services/salesforce-account-selection";
import { ExtensionModel } from "../extensions-page/extension-services/models";
import { ChatHeader } from "./chat-header/chat-header";
import {
  ChatDocumentModel,
  ChatMessageModel,
  ChatThreadModel,
} from "./chat-services/models";
import MessageContent from "./message-content";

interface ChatPageProps {
  messages: Array<ChatMessageModel>;
  chatThread: ChatThreadModel;
  chatDocuments: Array<ChatDocumentModel>;
  extensions: Array<ExtensionModel>;
  isAdmin: boolean;
}

type ChatUiRole = "user" | "system" | "assistant" | "tool";

function toUiRole(role: ChatMessageModel["role"]): ChatUiRole {
  if (role === "function") return "assistant";
  return role as ChatUiRole;
}

const BLOB_URL_RE = /^https?:\/\/[^/]+\.blob\.core\.windows\.net\//i;

export const ChatPage: FC<ChatPageProps> = (props) => {
  const { data: session } = useSession();
  const isAdmin = props.isAdmin;
  const [canvas,setCanvas]=useState<{content?:string;context:string;key:number}|null>(null);
  function openCanvas(content?:string) {
    if(canvas && !window.confirm("Canvasを開き直します。未保存の変更がある場合は破棄されます。続けますか？"))return;
    setCanvas({content,context:canvasChatContext(messages,content),key:Date.now()});
  }
  useEffect(()=>setCanvas(null),[props.chatThread.id]);

  useEffect(() => {
    chatStore.initChatSession({
      chatThread: props.chatThread,
      messages: props.messages,
      userName: session?.user?.name!,
    });
  }, [props.messages, session?.user?.name, props.chatThread]);

  const { messages, loading, chatThreadId } = useChat();
  const canvasWasGenerating=useRef(false);
  useEffect(()=>{
    const finished=canvasWasGenerating.current&&loading!=="loading";
    canvasWasGenerating.current=loading==="loading";
    if(!finished||canvas)return;
    const lastUserIndex=messages.map(message=>message.role).lastIndexOf("user");
    const lastUser=messages[lastUserIndex];
    const answer=messages.slice(lastUserIndex+1).reverse().find(message=>message.role==="assistant"&&message.content.trim());
    const request=lastUser?salesforcePresentationRequest(lastUser.content,messages.slice(0,lastUserIndex).reverse()):"";
    const requested=/(?:Canvas|キャンバス)\s*(?:に|で|へ).*(?:まとめ|作成|表示|整理|グラフ|作って)/i.test(request);
    const monthlyReport=answer?.content.startsWith("<!-- salesforce:monthly-report -->");
    if(answer&&!answer.content.startsWith("Salesforceの取引先を選択してください。")&&(requested||monthlyReport))setCanvas({content:answer.content,context:canvasChatContext(messages,answer.content),key:Date.now()});
  },[loading,messages,canvas]);
  const current = useRef<HTMLDivElement>(null);
  useChatScrollAnchor({ ref: current });

  return (
    <main className="relative flex h-dvh max-h-dvh min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex justify-end px-4 pt-2"><button type="button" onClick={()=>openCanvas()} className="rounded border px-3 py-1 text-sm">このチャットのCanvasを開く</button></div>
      <ChatHeader
        chatThread={props.chatThread}
        chatDocuments={props.chatDocuments}
        extensions={props.extensions}
        isAdmin={isAdmin}
      />
      <ChatMessageContainer ref={current}>
        <ChatMessageContentArea>
          {messages.map((message, index) => {
            let assistantDownloadUrl: string | null = null;
            let assistantDownloadName: string | null = null;
            if (message.role === "assistant" && index > 0) {
              for (let i = index - 1; i >= 0; i--) {
                const prev = messages[i];
                if (prev.role !== "tool" && prev.role !== "function") break;
                try {
                  const obj = JSON.parse(prev.content);
                  if (
                    typeof obj?.downloadUrl === "string" &&
                    BLOB_URL_RE.test(obj.downloadUrl)
                  ) {
                    assistantDownloadUrl = obj.downloadUrl;
                    assistantDownloadName = obj.displayName ?? obj.fileName ?? null;
                    break;
                  }
                } catch {}
              }
            }

            return (
              <ChatMessageArea
                key={message.id}
                profileName={message.name}
                role={toUiRole(message.role)}
                onCopy={() => {
                  navigator.clipboard.writeText(message.content);
                }}
                profilePicture={
                  message.role === "assistant"
                    ? "/ai-icon.png"
                    : session?.user?.image
                }
              >
                <MessageContent message={message} />
                {message.role==="assistant" && message.content.trim() && loading!=="loading" && <button type="button" onClick={()=>openCanvas(message.content)} className="not-prose mt-2 rounded border px-3 py-1 text-sm">上記内容のCanvasを開く</button>}
                {assistantDownloadUrl && (
                  <div className="not-prose mt-2">
                    <a
                      href={assistantDownloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
                    >
                      <Download size={14} strokeWidth={2} />
                      {assistantDownloadName ?? "ダウンロード"}
                    </a>
                  </div>
                )}
              </ChatMessageArea>
            );
          })}
          {loading === "loading" && <ChatLoading chatThreadId={chatThreadId} />}
        </ChatMessageContentArea>
      </ChatMessageContainer>
      <DeskNetsCredentialRegistration />
      <ChatInput isAdmin={isAdmin} />
      </div>
      {canvas&&<CanvasPanel key={`${props.chatThread.id}:${canvas.key}`} threadId={props.chatThread.id} initialContent={canvas.content} chatContext={canvas.context} onClose={()=>setCanvas(null)}/>}
    </main>
  );
};
