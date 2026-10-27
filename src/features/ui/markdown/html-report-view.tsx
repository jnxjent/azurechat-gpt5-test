"use client";
import { useState } from "react";
import { buildHtmlReport } from "./html-report";

export function HtmlReportView({ source }: { source: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  function download() {
    const url = URL.createObjectURL(new Blob([buildHtmlReport(source)], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "report.html";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="my-3 min-w-0 rounded border p-3">
    <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => setPreview(preview === null ? buildHtmlReport(source) : null)}>{preview === null ? "HTMLプレビュー" : "プレビューを閉じる"}</button>
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={download}>HTMLをダウンロード</button>
    </div>
    {preview !== null && <iframe title="HTMLレポートのプレビュー" sandbox="" referrerPolicy="no-referrer" srcDoc={preview} className="mt-3 h-[65vh] w-full rounded border bg-white" />}
    <details className="mt-2"><summary className="cursor-pointer text-sm">HTMLソースを表示</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{source}</pre></details>
  </div>;
}
