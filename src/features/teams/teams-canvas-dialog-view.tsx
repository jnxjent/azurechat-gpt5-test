"use client";
import Script from "next/script";
import {useEffect,useRef,useState} from "react";
import {signIn} from "next-auth/react";
import {SharedCanvasView} from "@/features/canvas/shared-canvas-view";
import {setCanvasDialogToken} from "@/features/canvas/canvas-fetch";

type TeamsSdk={app:{initialize:()=>Promise<void>};authentication:{authenticate:(input:{url:string;width:number;height:number})=>Promise<string>;notifySuccess:(result:string)=>void}};
function sdk(){return (window as unknown as {microsoftTeams?:TeamsSdk}).microsoftTeams;}
export function TeamsCanvasDialogView({popup=false}:{popup?:boolean}) {
  const launch=useRef(""),started=useRef(false),pending=useRef(false);
  const [ready,setReady]=useState(false),[id,setId]=useState(""),[error,setError]=useState(""),[login,setLogin]=useState(false),[status,setStatus]=useState("本人を確認しています…");
  useEffect(()=>{if(!launch.current)launch.current=new URLSearchParams(window.location.hash.slice(1)).get("launch")??"";window.history.replaceState(null,"",window.location.pathname);},[]);
  async function authorize() {
    const response=await fetch("/api/teams/canvas/dialog",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"authorize",launch:launch.current}),cache:"no-store"});
    const data=await response.json();if(!response.ok){if(response.status===401&&data.error==="ログインしてください。"){setLogin(true);return null;}throw Error(data.error||"本人を確認できません。");}
    return data as {token:string;id:string};
  }
  async function prepare(token:string) {
    setStatus("Salesforceから取得し、Canvasを作成・表示しています…");
    const response=await fetch("/api/teams/canvas/dialog",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({action:"prepare"}),cache:"no-store"});
    const data=await response.json();if(!response.ok)throw Error(data.error||"Canvasを開けませんでした。");
    setCanvasDialogToken(token);setId(data.id);setLogin(false);
  }
  async function begin() {
    if(pending.current)return;pending.current=true;setError("");
    try {
      if(!launch.current)throw Error("Teamsの新しいCanvasカードから開き直してください。");
      const result=await authorize();if(!result)return;
      if(popup){sdk()!.authentication.notifySuccess(JSON.stringify(result));return;}
      await prepare(result.token);
    }catch(e){setError(e instanceof Error?e.message:"Canvasを開けませんでした。");}
    finally{pending.current=false;}
  }
  useEffect(()=>{if(ready&&!started.current){started.current=true;void begin();}},[ready]);
  async function connect() {
    if(pending.current)return;pending.current=true;setError("");
    try {
      if(popup){await signIn("azure-ad",{callbackUrl:window.location.origin+"/teams/canvas/auth#launch="+encodeURIComponent(launch.current)});return;}
      const result=JSON.parse(await sdk()!.authentication.authenticate({url:window.location.origin+"/teams/canvas/auth#launch="+encodeURIComponent(launch.current),width:650,height:650}));
      await prepare(result.token);
    }catch{setError("Teamsと同じMicrosoftアカウントでのログインを完了してください。");}
    finally{pending.current=false;}
  }
  return <div className="h-full w-full overflow-y-auto">
    <Script src="https://res.cdn.office.net/teams-js/2.19.0/js/MicrosoftTeams.min.js" strategy="afterInteractive" onReady={()=>{void sdk()!.app.initialize().then(()=>setReady(true),()=>setError("TeamsのCanvasボタンから開いてください。"));}} onError={()=>setError("Teamsの画面初期化に失敗しました。開き直してください。")}/>
    {id?<SharedCanvasView id={id} embedded/>:<main className="mx-auto max-w-4xl space-y-4 p-6"><h1 className="text-xl font-semibold">Salesforce Canvas</h1>
      <p role="status">{login?"Teamsと同じMicrosoftアカウントで本人確認してください。":status}</p>
      {login&&<button className="rounded border px-4 py-2" onClick={()=>void connect()}>Microsoftアカウントで本人確認して開く</button>}
      {error&&<p role="alert">{error}</p>}
      {error&&!login&&<button className="rounded border px-4 py-2" onClick={()=>void begin()}>再確認</button>}
    </main>}
  </div>;
}
