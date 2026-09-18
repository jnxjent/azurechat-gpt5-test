"use client";

import { chatStore } from "@/features/chat-page/chat-store";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { DeskNetsApprovalRequest } from "./desknets-agent-types";

type DeskNetsApprovalToolResult = {
  runId: string;
  chatThreadId: string;
  approvalRequest: DeskNetsApprovalRequest;
};

const isApprovalRequest = (value: unknown): value is DeskNetsApprovalRequest => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.title === "string" &&
    typeof item.start === "string" &&
    typeof item.end === "string" &&
    Array.isArray(item.participantIds) &&
    item.participantIds.every((id) => typeof id === "string") &&
    typeof item.facilityId === "string" &&
    typeof item.emailNotificationWillBeSent === "boolean";
};

const parseApprovalToolResult = (
  value: Record<string, unknown> | null,
): DeskNetsApprovalToolResult | null => {
  if (
    typeof value?.runId !== "string" ||
    typeof value.chatThreadId !== "string" ||
    !isApprovalRequest(value.approvalRequest)
  ) {
    return null;
  }
  return {
    runId: value.runId,
    chatThreadId: value.chatThreadId,
    approvalRequest: value.approvalRequest,
  };
};

export const DeskNetsApprovalCard = ({
  toolResult,
}: {
  toolResult: Record<string, unknown> | null;
}) => {
  const parsed = parseApprovalToolResult(toolResult);
  if (!parsed) return null;

  return <ApprovalCard key={parsed.runId} {...parsed} />;
};

const ApprovalCard = ({
  runId,
  chatThreadId,
  approvalRequest: approval,
}: DeskNetsApprovalToolResult) => {
  const [localMessage, setLocalMessage] = useState("");
  const [openingLocal, setOpeningLocal] = useState(false);
  const openOnThisPC = async () => {
    if (openingLocal) return;
    setLocalMessage("");
    // Open synchronously on the user gesture; never navigate a shared VM tab.
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setLocalMessage("ポップアップを許可して、もう一度押してください。"); return; }
    tab.opener = null;
    setOpeningLocal(true);
    try {
      const response = await fetch(`/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}&handoff=1`, {cache:"no-store"});
      const result = await response.json();
      if (!response.ok || typeof result.handoffUrl !== "string") throw new Error(result.message ?? "引き渡しできませんでした。");
      const url = new URL(result.handoffUrl);
      if (url.origin !== "https://desknets.midac.jp" || url.pathname !== "/dneo/dneo.cgi" ||
          url.username || url.password || url.search !== "?cmd=schindex" || new URLSearchParams(url.hash.slice(1)).get("cmd") !== "schaddtarget") throw new Error("不正な引き渡し先です。");
      if (tab.closed) throw new Error("表示先タブが閉じられました。もう一度押してください。");
      tab.location.replace(url.href);
    } catch (error) {
      tab.close();
      setLocalMessage(error instanceof Error ? error.message : "引き渡しに失敗しました。");
    } finally {setOpeningLocal(false);}
  };

  const dateTime = (value: string) =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <div className="space-y-3 rounded-lg border-2 border-amber-500/70 bg-amber-500/10 p-4">
      <div className="font-semibold">DeskNet&apos;s 予定内容の最終確認</div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">議題</dt>
        <dd>{approval.title}</dd>
        <dt className="text-muted-foreground">日時</dt>
        <dd>{dateTime(approval.start)} ～ {dateTime(approval.end)}</dd>
        <dt className="text-muted-foreground">参加者</dt>
        <dd>{approval.participantIds.join("、")}</dd>
        <dt className="text-muted-foreground">会議室</dt>
        <dd>{approval.facilityId}</dd>
        <dt className="text-muted-foreground">メール</dt>
        <dd>{approval.emailNotificationWillBeSent ? "送信する" : "送信しない"}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openOnThisPC()} disabled={openingLocal}
            className="rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {openingLocal ? "開いています…" : "desknet'sを開く"}
          </button>
          <button
            type="button"
            onClick={() => void chatStore.submitText("候補に戻して")}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
          >
            <RotateCcw size={16} />候補に戻る
          </button>
        </div>
      {localMessage && <p className="text-sm" role="alert">{localMessage}</p>}
    </div>
  );
};
