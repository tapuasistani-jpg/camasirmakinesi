import { getStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FRESH = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
};

export async function GET() {
  try {
    return Response.json(await getStatus(), { headers: FRESH });
  } catch (error) {
    const message = error instanceof Error ? error.message : "durum okunamadı";
    return Response.json({ ready: false, message, alerts: [], recent: [], logs: [] }, { status: 500, headers: FRESH });
  }
}
