import { changeCanvasComment } from "@/features/canvas/shared-canvas-service";
import {withCanvasRequest} from "@/features/teams/teams-canvas-dialog";
import { canvasShareFailure,canvasShareInput,requireCanvasOrigin,sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:{id:string}}) {
  try {requireCanvasOrigin(request);return await withCanvasRequest(request,params.id,async()=>Response.json(await changeCanvasComment(params.id,await canvasShareInput(request,32000)),{headers:sharedCanvasHeaders}));}
  catch(error){return canvasShareFailure(error);}
}
