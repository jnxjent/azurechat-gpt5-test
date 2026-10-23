import { getSharedCanvas, changeSharedCanvas } from "@/features/canvas/shared-canvas-service";
import {withCanvasRequest} from "@/features/teams/teams-canvas-dialog";
import { canvasShareFailure, canvasShareInput, requireCanvasOrigin, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await withCanvasRequest(_request,params.id,()=>getSharedCanvas(params.id)), { headers: sharedCanvasHeaders }); }
  catch (error) { return canvasShareFailure(error); }
}
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    requireCanvasOrigin(request);
    return await withCanvasRequest(request,params.id,async()=>{
      const input=await canvasShareInput(request,400000),saved=await changeSharedCanvas(params.id,input);
      if(input.action==="access")console.info("[teams-canvas] sharing saved",{shareId:params.id,enabled:input.enabled===true,notifyRequested:input.notifyTeams===true,readers:Array.isArray(input.readers)?input.readers.length:0});
      const notifications=input.action==="access"&&input.enabled===true&&input.notifyTeams===true
        ?request.headers.has("Authorization")
          ?await (await import("@/features/teams/teams-canvas-notifications")).notifyTeamsCanvasShare(params.id,input.message)
          :await (await import("@/features/canvas/canvas-personal-notifications")).notifyPersonalCanvasShare(request,params.id,input.message)
        :undefined;
      return Response.json({...saved,...(notifications?{notifications}:{})}, { headers: sharedCanvasHeaders });
    });
  } catch (error) { return canvasShareFailure(error); }
}
