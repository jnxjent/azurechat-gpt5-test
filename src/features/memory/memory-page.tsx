"use client";

import { useEffect, useState } from "react";
import { memoryReferenceMode, memoryKindLabel } from "./memory-rules";
import type { UserMemory } from "./memory-rules";

const empty = { title: "", content: "", mode: "manual" as "always" | "required" | "manual", triggers: "", enabled: true };

export function MemoryPage() {
  const [items, setItems] = useState<UserMemory[]>([]);
  const [selected, setSelected] = useState<UserMemory | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const response = await fetch("/api/memories", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "メモを取得できませんでした。");
    setItems(data.items);
  }

  useEffect(() => { void refresh().catch((cause) => setError(String(cause))); }, []);

  function choose(item: UserMemory | null) {
    setSelected(item);
    setForm(item ? { title: item.title, content: item.content, mode: memoryReferenceMode(item),
      triggers: item.triggers.join("、"), enabled: item.enabled } : empty);
    setError("");
    setNotice("");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/memories", {
        method: selected ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, kind: "memo", id: selected?.id, version: selected?.version,
          triggers: form.triggers.split(/[、,\n]/).map((term) => term.trim()).filter(Boolean) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存できませんでした。");
      await refresh();
      choose(data.item);
      setNotice(`「${data.item.title}」を保存しました。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!selected || !window.confirm(`「${selected.title}」を削除しますか？`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/memories", { method: "DELETE",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selected.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "削除できませんでした。");
      await refresh(); choose(null); setNotice("メモを削除しました。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-6xl p-6">
    <h1 className="text-2xl font-semibold">メモ</h1>
    <p className="mt-2 text-sm text-muted-foreground">プロフィールは最小限に短縮して必須参照します。通常のメモは、名前の明示または関連度に応じて参照します。</p>
    <p className="mt-2 text-sm text-muted-foreground">プロフィールに「優先会議室：品川」などを記入すると、DeskNet'sの日程調整で会議室を省略した場合に使用します。今回指定した会議室を優先します。</p>
    <p className="mt-2 text-sm text-muted-foreground">チャットで「エラーでした」と伝えるとLearnedLessonを記録します。共通注意と失敗の詳細は、どちらも同じメモ一覧に保存します。</p>
    <div className="mt-6 grid gap-6 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <button disabled={busy} type="button" className="w-full rounded border px-3 py-2 text-left" onClick={() => choose(null)}>＋ 新しいメモ</button>
        {items.map((item) => <button disabled={busy} key={item.id} type="button" onClick={() => choose(item)}
          className={`w-full rounded border px-3 py-2 text-left ${selected?.id === item.id ? "border-primary" : ""}`}>
          <span className="block font-medium">{item.title}</span>
          <span className="text-xs text-muted-foreground">v{item.version} · {memoryKindLabel(item)}{item.learnedLesson ? " · LearnedLesson" : ""}{item.enabled ? "" : " · 無効"}</span>
        </button>)}
      </aside>
      <form onSubmit={save} className="space-y-4 rounded border p-5">
        <label className="block text-sm font-medium">保存名
          <input required maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })}
            className="mt-1 w-full rounded border bg-background p-2" placeholder="例: AzureChat TestSite デプロイ手順" />
        </label>
        <label className="block text-sm font-medium">参照条件
          <select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as "always" | "required" | "manual" })}
            className="mt-1 w-full rounded border bg-background p-2">
            <option value="always">毎回参照</option>
            <option value="required">プロフィール・必須参照</option>
            <option value="manual">個別参照（名前・関連度）</option>
          </select>
        </label>
        {form.mode === "manual" && <label className="block text-sm font-medium">呼び出し語（任意・読点または改行区切り）
          <input value={form.triggers} onChange={(event) => setForm({ ...form, triggers: event.target.value })}
            className="mt-1 w-full rounded border bg-background p-2" placeholder="例: TestSite デプロイ、テスト環境への反映" />
        </label>}
        {selected?.learnedLesson && <p className="text-sm text-muted-foreground">LearnedLesson（利用者の失敗報告・原因未検証）。原因と修正が確認できたら本文に追記してください。</p>}
        <label className="block text-sm font-medium">本文（Markdown）
          <textarea required maxLength={12000} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })}
            className="mt-1 min-h-[20rem] w-full rounded border bg-background p-3 font-mono text-sm" />
        </label>
        {selected && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />参照を有効にする</label>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <div className="flex gap-3">
          <button disabled={busy} type="submit" className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">保存</button>
          {selected && <button disabled={busy} type="button" onClick={() => void remove()} className="rounded border px-4 py-2 disabled:opacity-50">削除</button>}
        </div>
      </form>
    </div>
  </main>;
}
