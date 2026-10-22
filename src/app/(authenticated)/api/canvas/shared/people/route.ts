import { searchCanvasSharePeople } from "@/features/canvas/shared-canvas-service";
import { canvasShareFailure, sharedCanvasHeaders } from "@/features/canvas/shared-canvas-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try { return Response.json(await searchCanvasSharePeople(new URL(request.url).searchParams.get("q")??""),{headers:sharedCanvasHeaders}); }
  catch(error) { return canvasShareFailure(error); }
}
