import { getSavedCanvasSharing, publishSavedCanvas } from "@/features/canvas/shared-canvas-service";
import { canvasShareFailure, canvasShareInput, requireCanvasOrigin, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try { return Response.json(await getSavedCanvasSharing(new URL(request.url).searchParams.get("threadId")??""),{headers:sharedCanvasHeaders}); }
  catch(error) { return canvasShareFailure(error); }
}
export async function POST(request:Request) {
  try {
    requireCanvasOrigin(request);const input=await canvasShareInput(request,40000),saved=await publishSavedCanvas(input);
    const notifications=input.enabled&&input.notifyTeams===true?await (await import("@/features/teams/teams-canvas-notifications")).notifyTeamsCanvasShare(saved.id,input.message):undefined;
    return Response.json({...saved,...(notifications?{notifications}:{})},{headers:sharedCanvasHeaders});
  }
  catch(error) { return canvasShareFailure(error); }
}
