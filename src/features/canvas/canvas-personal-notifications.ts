import "server-only";
import {getToken} from "next-auth/jwt";
import {NextRequest} from "next/server";
import {canvasNotificationTargets} from "./shared-canvas-service";

type RecipientResult={name:string;email:string;status:"sent"|"failed"|"permission_required";reason?:string};
export type PersonalNotificationResult={channel:"personal";sent:number;failed:number;unavailable:number;recipients:RecipientResult[];error?:string};
const graph="https://graph.microsoft.com/v1.0";
const principalPattern=/^([a-f0-9-]{36}):([a-f0-9-]{36})$/i;
class GraphError extends Error {constructor(public status:number){super("Graph request failed");}}

/** Cookie-authenticated Web sharing only. Never use a dialog bearer or application token. */
export async function notifyPersonalCanvasShare(request:Request,shareId:string,message:unknown):Promise<PersonalNotificationResult> {
  const result:PersonalNotificationResult={channel:"personal",sent:0,failed:0,unavailable:0,recipients:[]};
  try {
    const targets=await canvasNotificationTargets(shareId);
    const recipients=Array.from(new Map(targets.readers.map(reader=>[reader.principal,reader])).values());
    for(const reader of targets.unavailableReaders) {
      result.failed++;result.recipients.push({name:reader.name??reader.email,email:reader.email,status:"failed",reason:"共有先の参照権限を確認できません。"});
    }
    const finishAll=(status:"failed"|"permission_required",reason:string)=>{
      for(const reader of recipients) {
        result[status==="failed"?"failed":"unavailable"]++;
        result.recipients.push({name:reader.name??reader.email,email:reader.email,status,reason});
      }
      return result;
    };
    if(process.env.CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED!=="true")return finishAll("permission_required","通知機能は未有効です。共有URLをコピーして送ってください。");
    if(message!==undefined&&(typeof message!=="string"||new TextEncoder().encode(message).length>4000))return finishAll("failed","共有メッセージを確認してください。");
    // getToken also accepts bearer tokens. This path must only use the Web session cookie.
    if(request.headers.has("Authorization"))return finishAll("permission_required","Web版にログインして共有してください。共有URLをコピーして送ってください。");
    // Copy only headers: the route has already consumed the original request body.
    const auth=await getToken({req:new NextRequest(request.url,{headers:request.headers})});
    const scopes=new Set((typeof auth?.graphScopes==="string"?auth.graphScopes:"").split(/\s+/).map(scope=>scope.replace(/^https:\/\/graph\.microsoft\.com\//i,"")));
    if(auth?.graphProvider!=="azure-ad"||typeof auth.accessToken!=="string"||!auth.accessToken||auth.refreshError||typeof auth.accessTokenExpiresAt!=="number"||!Number.isFinite(auth.accessTokenExpiresAt)||auth.accessTokenExpiresAt<=Date.now()/1000+60||!scopes.has("Chat.Create")||!scopes.has("ChatMessage.Send"))return finishAll("permission_required","権限なし（管理者同意後に再ログインが必要）。共有URLをコピーして送ってください。");
    if(auth.salesforcePrincipal!==targets.owner.principal||auth.email?.trim().toLowerCase()!==targets.owner.email)return finishAll("failed","共有した本人のMicrosoftログインを確認してください。");
    const owner=principalPattern.exec(targets.owner.principal);
    const tenant=process.env.AZURE_AD_TENANT_ID?.trim().toLowerCase();
    if(!owner||owner[1].toLowerCase()!==tenant)return finishAll("failed","共有した本人の所属組織を確認できません。");
    const base=new URL(process.env.NEXTAUTH_URL??"");
    if(base.protocol!=="https:"||base.username||base.password)return finishAll("failed","共有URLの設定を確認してください。");
    const url=new URL(`/canvas/shared/${encodeURIComponent(shareId)}`,base).href;
    const graphRequest=async(path:string,body?:unknown)=>{
      const response=await fetch(graph+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${auth!.accessToken}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new GraphError(response.status);
      return response.json();
    };
    try {
      // Graph validates the delegated token; bind its actual user to the Canvas owner.
      const me=await graphRequest("/me?$select=id");
      if(typeof me.id!=="string"||me.id.toLowerCase()!==owner[2].toLowerCase())return finishAll("failed","通知の送信者と共有した本人が一致しません。");
    }catch(error){return finishAll(error instanceof GraphError&&[401,403].includes(error.status)?"permission_required":"failed","Microsoftの権限を確認し、再ログインしてください。共有URLをコピーして送ってください。");}
    for(const recipient of recipients) {
      const receipt:RecipientResult={name:recipient.name??recipient.email,email:recipient.email,status:"failed"};
      try {
        const target=principalPattern.exec(recipient.principal);
        if(!target||target[1].toLowerCase()!==tenant||target[2].toLowerCase()===owner[2].toLowerCase())throw Error("Invalid recipient");
        const authorized=async()=>{
          const current=await canvasNotificationTargets(shareId,targets.revision);
          if(current.revision!==targets.revision||!current.readers.some(reader=>reader.principal===recipient.principal&&reader.email===recipient.email))throw Error("Sharing changed");
        };
        await authorized();
        const chat=await graphRequest("/chats",{chatType:"oneOnOne",members:[owner[2],target[2]].map(id=>({"@odata.type":"#microsoft.graph.aadUserConversationMember",roles:["owner"],"user@odata.bind":`${graph}/users('${id}')`}))});
        if(typeof chat.id!=="string"||!chat.id||chat.id.length>2000)throw Error("Invalid chat");
        await authorized();
        // Plain text prevents markup injection; never include report data or financial figures.
        await graphRequest(`/chats/${encodeURIComponent(chat.id)}/messages`,{body:{contentType:"text",content:`Canvasを共有しました。\n${url}${typeof message==="string"&&message.trim()?"\n\n"+message.trim():""}`}});
        receipt.status="sent";result.sent++;
      }catch(error){
        if(error instanceof GraphError&&[401,403].includes(error.status)) {
          receipt.status="permission_required";receipt.reason="権限なし（再ログインが必要）。管理者の同意も確認してください。共有URLをコピーして送ってください。";result.unavailable++;
        }else {receipt.reason="送信できませんでした。共有URLをコピーして送ってください。";result.failed++;}
      }
      // No automatic retry: a timeout can occur after Graph has accepted a message.
      result.recipients.push(receipt);
    }
  }catch {result.error="共有は保存しましたが、Teams通知を確認できませんでした。共有URLをコピーして送ってください。";}
  return result;
}
