"use client";

import {
  ResetInputRows,
  onKeyDown,
  onKeyUp,
  useChatInputDynamicHeight,
} from "@/features/chat-page/chat-input/use-chat-input-dynamic-height";

import { AttachFile } from "@/features/ui/chat/chat-input-area/attach-file";
import {
  ChatInputActionArea,
  ChatInputForm,
  ChatInputPrimaryActionArea,
  ChatInputSecondaryActionArea,
} from "@/features/ui/chat/chat-input-area/chat-input-area";
import { ChatTextInput } from "@/features/ui/chat/chat-input-area/chat-text-input";
import { ImageInput } from "@/features/ui/chat/chat-input-area/image-input";
import {
  InputImageStore,
  isSupportedChatImageFile,
} from "@/features/ui/chat/chat-input-area/input-image-store";
import { Microphone } from "@/features/ui/chat/chat-input-area/microphone";
import { StopChat } from "@/features/ui/chat/chat-input-area/stop-chat";
import { SubmitChat } from "@/features/ui/chat/chat-input-area/submit-chat";
import React, { useRef, useState } from "react";
import { useSkillSuggestions } from "@/features/skills/use-skill-suggestions";
import { useSession } from "next-auth/react";
import { showError } from "@/features/globals/global-message-store";
import { chatStore, useChat } from "../chat-store";
import { fileStore, useFileStore } from "./file/file-store";
import { PromptSlider } from "./prompt/prompt-slider";
import {
  speechToTextStore,
  useSpeechToText,
} from "./speech/use-speech-to-text";
import {
  textToSpeechStore,
  useTextToSpeech,
} from "./speech/use-text-to-speech";

type UploadScope = "common" | "personal";

export const ChatInput = ({ isAdmin: isAdminProp }: { isAdmin?: boolean }) => {
  const { loading, input, chatThreadId } = useChat();
  const textInput = useRef<HTMLTextAreaElement>(null);
  const { data: session } = useSession();
  const suggestions = useSkillSuggestions(input, chatThreadId, loading === "idle", value => {
    chatStore.updateInput(value);
    textInput.current?.focus();
  }, session?.user?.email ?? "");
  const { uploadButtonLabel } = useFileStore();
  const { isPlaying } = useTextToSpeech();
  const { isMicrophoneReady } = useSpeechToText();
  const { rows } = useChatInputDynamicHeight();

  const submitButton = React.useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const mode = "standard";

  // ★ 管理者判定（セッションのisAdminを使用 - ビルド時env不要）
  const isAdmin = isAdminProp ?? Boolean((session?.user as any)?.isAdmin);

  const [uploadScope, setUploadScope] = useState<UploadScope>("personal");

  const submit = () => {
    if (loading !== "idle") return;
    if (formRef.current) {
      formRef.current.requestSubmit();
    }
  };

  return (
    <ChatInputForm
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        if (loading === "file upload") {
          showError("画像のアップロード完了後に送信してください。");
          return;
        }
        if (loading !== "idle") return;
        chatStore.submitChat(e);
      }}
      status={uploadButtonLabel}
    >
      <input type="hidden" name="thinkingMode" value={mode} />
      {suggestions.selectedSkill && <>
        <input type="hidden" name="selectedSkillId" value={suggestions.selectedSkill.id} />
        <input type="hidden" name="selectedSkillVersion" value={suggestions.selectedSkill.version} />
        <div className="flex items-center gap-2 px-3 py-2 text-sm">使用Skill：{suggestions.selectedSkill.title}（{suggestions.selectedSkill.scope === "shared" ? `全社公開・${suggestions.selectedSkill.ownerName ?? "社員"}` : "自分のSkill"}）<button type="button" onClick={suggestions.clearSelection} className="underline">選択を解除</button></div>
      </>}

      {suggestions.candidates.length > 0 && <div id="skill-suggestions" className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" aria-label="使えるスキル候補">
        <span className="text-muted-foreground">スキル候補（↑↓で選択・Tabで確定）</span>
        <span aria-live="polite" className="sr-only">選択中：{suggestions.candidates[suggestions.activeIndex]?.title}</span>
        {suggestions.candidates.map((skill,index) => <button key={skill.id} id={`skill-suggestion-${index}`} type="button" aria-pressed={index === suggestions.activeIndex} className={`rounded border px-2 py-1 hover:bg-muted ${index === suggestions.activeIndex ? "ring-2 ring-primary" : ""}`} title={skill.description}
          onMouseDown={e => e.preventDefault()} onClick={() => suggestions.select(skill)}>{skill.title}{skill.scope === "shared" ? `（全社公開・${skill.ownerName ?? "社員"}）` : ""}</button>)}
      </div>}

      <ChatTextInput
        ref={textInput}
        aria-describedby={suggestions.candidates.length ? "skill-suggestions" : undefined}
        onCompositionStart={() => suggestions.setComposing(true)}
        onCompositionEnd={() => suggestions.setComposing(false)}
        onBlur={(e) => {
          if (e.currentTarget.value.replace(/\s/g, "").length === 0) {
            ResetInputRows();
          }
        }}
        onKeyDown={(e) => {
          if (suggestions.onKeyDown(e)) return;
          onKeyDown(e, submit);
        }}
        onKeyUp={(e) => {
          onKeyUp(e);
        }}
        value={input}
        rows={rows}
        onChange={(e) => {
          chatStore.updateInput(e.currentTarget.value);
        }}
      />

      <ChatInputActionArea>
        <ChatInputSecondaryActionArea>
          <AttachFile
            onClick={async (formData) => {
              const selectedFile = formData.get("file");
              if (
                selectedFile instanceof File &&
                isSupportedChatImageFile(selectedFile)
              ) {
                try {
                  // Stage the image before the network upload begins so the
                  // chat form can never observe an empty image-base64 value.
                  await InputImageStore.SetFile(selectedFile);
                  const uploaded = await fileStore.onImageFileChange({
                    formData,
                    chatThreadId,
                    uploadScope: isAdmin ? uploadScope : undefined,
                  });
                  if (!uploaded) InputImageStore.Reset();
                } catch (error) {
                  InputImageStore.Reset();
                  showError(String(error));
                }
                return;
              }

              await fileStore.onFileChange({
                formData,
                chatThreadId,
                uploadScope: isAdmin ? uploadScope : undefined,
              });
            }}
          />

          <PromptSlider />

          {/* ★ 管理者のみ：アップロード先トグル（共通 / 個人） */}
          {isAdmin && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>UP先:</span>

              {(
                [
                  { value: "common" as const, label: "共通" },
                  { value: "personal" as const, label: "個人" },
                ] as const
              ).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setUploadScope(item.value)}
                  className={`px-2 py-0.5 rounded border text-xs transition-colors ${
                    uploadScope === item.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-muted-foreground hover:bg-muted"
                  }`}
                  aria-pressed={uploadScope === item.value}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </ChatInputSecondaryActionArea>

        <ChatInputPrimaryActionArea>
          <ImageInput />
          <Microphone
            startRecognition={() => speechToTextStore.startRecognition()}
            stopRecognition={() => speechToTextStore.stopRecognition()}
            isPlaying={isPlaying}
            stopPlaying={() => textToSpeechStore.stopPlaying()}
            isMicrophoneReady={isMicrophoneReady}
          />
          {loading === "loading" ? (
            <StopChat stop={() => chatStore.stopGeneratingMessages()} />
          ) : (
            <SubmitChat
              ref={submitButton}
              disabled={loading !== "idle"}
            />
          )}
        </ChatInputPrimaryActionArea>
      </ChatInputActionArea>
    </ChatInputForm>
  );
};
