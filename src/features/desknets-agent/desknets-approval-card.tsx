"use client";

import { chatStore } from "@/features/chat-page/chat-store";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
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

  return <ApprovalCard {...parsed} />;
};

const ApprovalCard = ({
  runId,
  chatThreadId,
  approvalRequest: approval,
}: DeskNetsApprovalToolResult) => {
  const [state, setState] = useState<
    "idle" | "submitting" | "completed" | "failed"
  >("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState(approval.title || "打ち合わせ");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/desknets-agent/runs/${encodeURIComponent(runId)}?chatThreadId=${encodeURIComponent(chatThreadId)}`,
          { cache: "no-store" },
        );
        const run = await response.json();
        if (cancelled) return;
        if (run.status === "completed") {
          setState("completed");
          setMessage(
            run.result?.assistantMessage ??
              "DeskNet'sへの予定登録が完了しました。",
          );
        } else if (run.status === "queued" || run.status === "running") {
          setState("submitting");
          timer = setTimeout(refresh, 1000);
        } else if (run.status === "failed" || run.status === "cancelled") {
          setState("failed");
          setMessage(run.message ?? run.error ?? "予定登録に失敗しました。");
        }
      } catch {
        // The initial refresh is best-effort. Approval reports actionable errors.
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [chatThreadId, runId]);

  const approve = async () => {
    if (state !== "idle" && state !== "failed") return;
    setState("submitting");
    setMessage("");
    try {
      const response = await fetch(
        `/api/desknets-agent/runs/${encodeURIComponent(runId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatThreadId, title: title.trim() }),
        },
      );
      const run = await response.json();
      if (response.ok && run.status === "completed") {
        setState("completed");
        setMessage(
          run.result?.assistantMessage ??
            "DeskNet'sへの予定登録が完了しました。",
        );
        return;
      }
      setState("failed");
      setMessage(run.message ?? run.error ?? "予定登録に失敗しました。");
    } catch (error) {
      setState("failed");
      setMessage(`予定登録に失敗しました: ${String(error)}`);
    }
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
        <dd>
          <input
            type="text"
            value={title}
            maxLength={100}
            disabled={state === "submitting" || state === "completed"}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1"
          />
        </dd>
        <dt className="text-muted-foreground">日時</dt>
        <dd>{dateTime(approval.start)} ～ {dateTime(approval.end)}</dd>
        <dt className="text-muted-foreground">参加者</dt>
        <dd>{approval.participantIds.join("、")}</dd>
        <dt className="text-muted-foreground">会議室</dt>
        <dd>{approval.facilityId}</dd>
        <dt className="text-muted-foreground">メール</dt>
        <dd>{approval.emailNotificationWillBeSent ? "送信する" : "送信しない"}</dd>
      </dl>
      {state === "completed" ? (
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
          <CheckCircle2 size={18} />
          {message}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void approve()}
            disabled={state === "submitting" || title.trim() === ""}
            className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {state === "submitting" && (
              <Loader2 size={16} className="animate-spin" />
            )}
            {state === "submitting"
              ? "登録しています…"
              : "確定してDeskNet'sに登録"}
          </button>
          <button
            type="button"
            onClick={() => void chatStore.submitText("候補に戻して")}
            disabled={state === "submitting"}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
          >
            <RotateCcw size={16} />候補に戻る
          </button>
        </div>
      )}
      {state === "failed" && (
        <p className="text-sm text-destructive">{message}</p>
      )}
      <p className="text-xs text-muted-foreground">
        「確定」を押すまでDeskNet&apos;sには登録されません。
      </p>
    </div>
  );
};
