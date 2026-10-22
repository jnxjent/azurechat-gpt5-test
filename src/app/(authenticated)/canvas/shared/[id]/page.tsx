import { SharedCanvasView } from "@/features/canvas/shared-canvas-view";
export const dynamic = "force-dynamic";
export default function SharedCanvasPage({ params }: { params: { id: string } }) { return <SharedCanvasView id={params.id} />; }
