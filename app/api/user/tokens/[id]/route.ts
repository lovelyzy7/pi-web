import { NextRequest } from "next/server";
import { listApiTokens, revokeApiToken } from "@/lib/api-tokens";
import { readAccount, recordAuthEvent } from "@/lib/auth-store";
import { noStore, requestContext, requireAccountMode } from "@/lib/user-api";

export const dynamic = "force-dynamic";

/** Revokes one API token. The token itself is never needed, only its row id. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;

  const { id } = await params;
  const tokenId = Number(id);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    return noStore({ error: "invalid_token_id" }, 400);
  }
  if (!listApiTokens(mode.db).some((token) => token.id === tokenId)) {
    return noStore({ error: "unknown_token" }, 404);
  }

  const revoked = revokeApiToken(tokenId, mode.db);
  const context = requestContext(request);
  recordAuthEvent({
    kind: "token",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "revoked", tokenId },
  }, mode.db);

  return noStore({ ok: true, revoked });
}
