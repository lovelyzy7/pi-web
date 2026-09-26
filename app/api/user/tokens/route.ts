import { NextRequest } from "next/server";
import { readAccount, recordAuthEvent } from "@/lib/auth-store";
import {
  API_TOKEN_SCOPES,
  createApiToken,
  listApiTokens,
  normalizeScopes,
  pruneApiTokens,
} from "@/lib/api-tokens";
import {
  noStore,
  requestContext,
  requireAccountMode,
  requireJsonBody,
  requirePassword,
} from "@/lib/user-api";

export const dynamic = "force-dynamic";

const MAX_TOKEN_NAME_LENGTH = 60;
const MAX_TOKEN_DAYS = 3650;

/**
 * API tokens for this account.
 *
 * GET  → tokens without their secrets (the plaintext exists only in the
 *        creation response)
 * POST → create one, confirmed with the account password
 */

export async function GET(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;

  pruneApiTokens(mode.db);
  return noStore({
    mode: "account",
    scopes: API_TOKEN_SCOPES,
    tokens: listApiTokens(mode.db).map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;
  const contentTypeError = requireJsonBody(request);
  if (contentTypeError) return contentTypeError;

  const body = await request.json().catch(() => null) as
    | { name?: unknown; scopes?: unknown; expiresInDays?: unknown; password?: unknown }
    | null;

  const passwordError = await requirePassword(body?.password, mode.db, {
    action: "token-create",
    request,
  });
  if (passwordError) return passwordError;

  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  const name = rawName.slice(0, MAX_TOKEN_NAME_LENGTH) || "API token";
  const scopes = normalizeScopes(body?.scopes);

  const days = Number(body?.expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0
    ? Date.now() + Math.min(days, MAX_TOKEN_DAYS) * 24 * 60 * 60 * 1000
    : null;

  const { token, record } = createApiToken({ name, scopes, expiresAt, db: mode.db });
  const context = requestContext(request);
  recordAuthEvent({
    kind: "token",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "created", name, scopes, expiresAt },
  }, mode.db);

  // The plaintext token is returned exactly once.
  return noStore({
    ok: true,
    token,
    record: {
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      scopes: record.scopes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    },
  });
}
