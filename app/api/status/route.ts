import { getStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : "durum okunamadı";
    return Response.json({ ready: false, message, alerts: [], recent: [], logs: [] }, { status: 500 });
  }
}
