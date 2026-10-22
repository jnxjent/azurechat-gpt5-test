import { getSavedCanvasSharing, publishSavedCanvas } from "@/features/canvas/shared-canvas-service";
import { canvasShareFailure, canvasShareInput, requireCanvasOrigin, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try { return Response.json(await getSavedCanvasSharing(new URL(request.url).searchParams.get("threadId")??""),{headers:sharedCanvasHeaders}); }
  catch(error) { return canvasShareFailure(error); }
}
export async function POST(request:Request) {
  try { requireCanvasOrigin(request);return Response.json(await publishSavedCanvas(await canvasShareInput(request)),{headers:sharedCanvasHeaders}); }
  catch(error) { return canvasShareFailure(error); }
}
