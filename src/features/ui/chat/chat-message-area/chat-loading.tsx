"use client";

import { useEffect, useState } from "react";
import { LoadingIndicator } from "../../loading";

type QueueView = {
  status: string;
  waitingPosition?: number;
  waitingCount?: number;
  activeCount?: number;
};

export const ChatLoading = ({ chatThreadId }: { chatThreadId: string }) => {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [wasWaiting, setWasWaiting] = useState(false);

  useEffect(() => {
    if (!chatThreadId) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/desknets-agent/queue?chatThreadId=${encodeURIComponent(chatThreadId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const body = await response.json() as QueueView;
        if (!active) return;
        if (body.status === "queued" && typeof body.waitingPosition === "number") setWasWaiting(true);
        setQueue(body);
      } catch { /* Keep the ordinary loading indicator during a transient network error. */ }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [chatThreadId]);

  const text = queue?.status === "queued" && typeof queue.waitingPosition === "number"
    ? `DeskNet's の処理待ちです。待ち順 ${queue.waitingPosition} 番目。空き次第、自動で開始します。`
    : queue?.status === "running"
      ? wasWaiting ? "順番が来ました。DeskNet's の処理を開始しました。" : "DeskNet's を処理中です。"
      : wasWaiting && queue?.status === "completed"
        ? "DeskNet's の処理が終わりました。回答を準備しています。"
        : "回答を準備しています。";
  return (
    <div className="flex items-center justify-center gap-3 p-8" role="status" aria-live="polite">
      <LoadingIndicator isLoading={true} />
      <span>{text}</span>
    </div>
  );
};
