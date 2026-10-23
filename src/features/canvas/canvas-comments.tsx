"use client";
import { useState } from "react";
export type SharedComment={id:string;parentId?:string;authorName:string;department:string;body:string;createdAt:string;updatedAt:string;reportVersion:number;deleted:boolean;mine:boolean};
export type CommentChange={action:"create"|"edit"|"delete";id?:string;parentId?:string;body?:string};
export function CanvasComments({comments,canComment,busy,onChange}:{comments:SharedComment[];canComment:boolean;busy:boolean;onChange:(input:CommentChange)=>Promise<boolean>}) {
  const [body,setBody]=useState(""),[reply,setReply]=useState<SharedComment|null>(null),[edit,setEdit]=useState<SharedComment|null>(null);
  const reset=()=>{setBody("");setReply(null);setEdit(null);};
  const date=(value:string)=>new Date(value).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"});
  const render=(comment:SharedComment)=><div key={comment.id} className="rounded border p-3 space-y-2">
    <p className="text-sm"><strong>{comment.authorName}</strong> ／ {comment.department||"部署未登録"}</p>
    <p className="text-xs text-muted-foreground">{date(comment.createdAt)}（日本時間）／ レポート版 {comment.reportVersion}{comment.updatedAt!==comment.createdAt?" ／ 更新済み":""}</p>
    <p className="whitespace-pre-wrap break-words">{comment.deleted?"このコメントは削除されました。":comment.body}</p>
    {canComment&&!comment.deleted&&<div className="flex gap-4 text-sm">
      <button disabled={busy} type="button" className="underline" onClick={()=>{setReply(comment);setEdit(null);setBody("");}}>返信</button>
      {comment.mine&&<><button disabled={busy} type="button" className="underline" onClick={()=>{setEdit(comment);setReply(null);setBody(comment.body);}}>編集</button><button disabled={busy} type="button" className="underline" onClick={()=>{if(window.confirm("このコメントを削除しますか？"))void onChange({action:"delete",id:comment.id}).then(ok=>{if(ok&&(edit?.id===comment.id||reply?.id===comment.id))reset();});}}>削除</button></>}
    </div>}
  </div>;
  return <section aria-label="レポートのコメント" className="space-y-4 border-t pt-5">
    <h2 className="text-xl font-semibold">コメント</h2>
    <p className="text-sm">レポート全体へのコメントです。本文やSalesforceデータは変更しません。レポート更新後も残ります。</p>
    {!comments.length&&<p>コメントはまだありません。</p>}
    {comments.filter(c=>!c.parentId).map(root=><div key={root.id} className="space-y-2">{render(root)}<div className="ml-5 space-y-2">{comments.filter(c=>c.parentId===root.id).map(render)}</div></div>)}
    {canComment?<form className="space-y-2" onSubmit={e=>{e.preventDefault();void onChange(edit?{action:"edit",id:edit.id,body}:{action:"create",body,...(reply?{parentId:reply.id}:{})}).then(ok=>{if(ok)reset();});}}>
      {(edit||reply)&&<p className="text-sm">{edit?"自分のコメントを編集中":`${reply?.authorName}さんへ返信`} <button type="button" className="underline" disabled={busy} onClick={reset}>取消</button></p>}
      <label className="block">{edit?"編集内容":"コメントを入力"}<textarea className="mt-1 block min-h-24 w-full rounded border bg-background p-2" value={body} maxLength={4000} disabled={busy} onChange={e=>setBody(e.target.value)}/></label>
      <p className="text-xs">4000バイト以内（日本語の目安：約1300文字）</p>
      <button type="submit" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||!body.trim()||new TextEncoder().encode(body).length>4000}>{busy?"処理中…":edit?"変更を保存":"コメントを投稿"}</button>
    </form>:<p className="text-sm">閲覧のみの権限です。コメントするには所有者へ権限変更を依頼してください。</p>}
  </section>;
}
