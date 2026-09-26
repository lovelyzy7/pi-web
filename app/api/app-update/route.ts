import { NextResponse } from "next/server";
import { getAppUpdateStatus } from "@/lib/app-update-service";

export const dynamic = "force-dynamic";

/**
 * Kept for the in-app banner, which only needs "is there a newer release".
 * The cache lives in the database now (`update_checks`), so a restart does not
 * re-query npm and the updates page and the banner cannot disagree.
 */
export async function GET() {
  try {
    const status = await getAppUpdateStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
