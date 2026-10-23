import { SharedCanvasView } from "@/features/canvas/shared-canvas-view";
export const dynamic = "force-dynamic";
export default function SharedCanvasPage({ params }: { params: { id: string } }) { return <div className="h-full min-h-0 w-full overflow-y-auto"><SharedCanvasView id={params.id} /></div>; }
