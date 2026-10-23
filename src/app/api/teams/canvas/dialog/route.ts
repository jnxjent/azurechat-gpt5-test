import {authorizeCanvasDialog,prepareCanvasDialog} from "@/features/teams/teams-canvas-dialog";
import {canvasShareFailure,canvasShareInput,requireCanvasOrigin,sharedCanvasHeaders} from "@/features/canvas/shared-canvas-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request) {
  try {
    requireCanvasOrigin(request);
    const input=await canvasShareInput(request,20000);
    const result=input.action==="authorize"?await authorizeCanvasDialog(input.launch):input.action==="prepare"?await prepareCanvasDialog(request):null;
    if(!result)return Response.json({error:"操作を確認してください。"},{status:400,headers:sharedCanvasHeaders});
    return Response.json(result,{headers:sharedCanvasHeaders});
  }catch(error){return canvasShareFailure(error);}
}
