"use client";

import { useEffect, useRef, useState } from "react";

export function DeskNetsCredentialRegistration() {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [sharedReady, setSharedReady] = useState(true);
  const [transportReady, setTransportReady] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/desknets-agent/credentials", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (active && typeof body?.registered === "boolean") {
          setRegistered(body.registered);
          setSharedReady(body.sharedReady === true);
          setTransportReady(body.transportReady === true);
        }
      }).catch(() => {});
    return () => { active = false; };
  }, []);

  if (registered === null) return null;

  return (
    <section className="mx-4 mb-2 rounded-md border bg-background px-3 py-2 text-sm" aria-label="DeskNet's ログイン設定">
      <div className="flex items-center justify-between gap-2">
        <span>{!sharedReady ? "DeskNet's 共通入口の認証が未設定です。管理者に連絡してください。" :
          !transportReady ? "DeskNet's ログイン登録の通信設定が未完了です。管理者に連絡してください。" :
          registered ? "DeskNet's ログイン登録済み" : "DeskNet's を使う前に、ご自身のログインを登録してください。"}</span>
        {(sharedReady && transportReady || registered) && <button type="button" className="underline" onClick={() => { setEditing(!editing); setMessage(""); }}>
          {editing ? "閉じる" : registered ? "更新" : "登録"}
        </button>}
      </div>
      {editing && (
        <form ref={form} className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setMessage("");
          const data = new FormData(event.currentTarget);
          try {
            const response = await fetch("/api/desknets-agent/credentials", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
              cache: "no-store",
            });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.error ?? body?.message ?? "登録できませんでした。");
            form.current?.reset();
            setRegistered(true);
            setEditing(false);
            setMessage("DeskNet's ログインを登録しました。");
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "登録できませんでした。");
          } finally {
            setSaving(false);
          }
        }}>
          {sharedReady && transportReady && <><label className="flex flex-col gap-1">DeskNet's ID
            <input name="username" autoComplete="username" required maxLength={200} className="rounded border px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">DeskNet's パスワード
            <input name="password" type="password" autoComplete="current-password" required maxLength={1024} className="rounded border px-2 py-1" />
          </label>
          <button type="submit" disabled={saving} className="rounded border px-3 py-1 disabled:opacity-50">
            {saving ? "保存中…" : "暗号化して保存"}
          </button></>}
          {registered && <button type="button" disabled={saving} className="rounded border px-3 py-1 disabled:opacity-50"
            onClick={async () => {
              setSaving(true);
              setMessage("");
              try {
                const response = await fetch("/api/desknets-agent/credentials", { method: "DELETE", cache: "no-store" });
                const body = await response.json().catch(() => null);
                if (!response.ok) throw new Error(body?.error ?? body?.message ?? "登録を解除できませんでした。");
                form.current?.reset();
                setRegistered(false);
                setEditing(false);
                setMessage("DeskNet's ログイン登録を解除しました。");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "登録を解除できませんでした。");
              } finally {
                setSaving(false);
              }
            }}>登録解除</button>}
        </form>
      )}
      {message && <p role="status" className="mt-2">{message}</p>}
    </section>
  );
}
