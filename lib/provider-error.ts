/**
 * Turns a raw provider failure into something an operator can act on.
 *
 * pi reports an HTTP failure from a model provider as
 *
 *   Error: 402 {"type":"error","error":{"type":"insufficient_balance_error",
 *     "message":"insufficient balance (1008)"},"request_id":"…"}
 *
 * which is accurate and useless in a chat bubble: the status, the provider's
 * error type and the request id are all in there, but the reader has to parse
 * JSON to learn that the account has no credit. This module recognises that
 * shape and keeps the parts worth showing.
 *
 * It is deliberately presentation-only: nothing here changes what the agent
 * does, it only decides how the failure is described.
 */

export type ProviderErrorKind =
  | "insufficient_balance"
  | "invalid_credentials"
  | "rate_limited"
  | "model_not_found"
  | "context_length"
  | "content_filtered"
  | "provider_unavailable"
  | "unknown";

export interface ProviderError {
  /** HTTP status, when the text carried one. */
  status: number | null;
  /** The provider's own error type/code, when it sent one. */
  code: string | null;
  /** The provider's message, without the surrounding JSON. */
  message: string;
  /** `request_id`, `requestId`, … whichever the provider used. */
  requestId: string | null;
  kind: ProviderErrorKind;
  /** The original text, for the "details" disclosure. */
  raw: string;
}

/** Provider error types that map onto a kind, lowercased and de-suffixed. */
const KIND_BY_CODE: Record<string, ProviderErrorKind> = {
  insufficient_balance_error: "insufficient_balance",
  insufficient_quota: "insufficient_balance",
  insufficient_funds: "insufficient_balance",
  quota_exceeded: "insufficient_balance",
  billing_hard_limit_reached: "insufficient_balance",
  invalid_api_key: "invalid_credentials",
  authentication_error: "invalid_credentials",
  unauthorized: "invalid_credentials",
  permission_denied: "invalid_credentials",
  rate_limit_error: "rate_limited",
  rate_limit_exceeded: "rate_limited",
  too_many_requests: "rate_limited",
  model_not_found: "model_not_found",
  not_found_error: "model_not_found",
  context_length_exceeded: "context_length",
  context_window_exceeded: "context_length",
  content_filter: "content_filtered",
  content_policy_violation: "content_filtered",
  overloaded_error: "provider_unavailable",
  internal_server_error: "provider_unavailable",
  service_unavailable: "provider_unavailable",
  api_error: "provider_unavailable",
};

const KIND_BY_STATUS: Record<number, ProviderErrorKind> = {
  401: "invalid_credentials",
  402: "insufficient_balance",
  403: "invalid_credentials",
  404: "model_not_found",
  413: "context_length",
  429: "rate_limited",
  500: "provider_unavailable",
  502: "provider_unavailable",
  503: "provider_unavailable",
  504: "provider_unavailable",
};

function kindFor(code: string | null, status: number | null): ProviderErrorKind {
  if (code) {
    const normalized = code.toLowerCase();
    const direct = KIND_BY_CODE[normalized];
    if (direct) return direct;
    for (const [needle, kind] of Object.entries(KIND_BY_CODE)) {
      if (normalized.includes(needle.replace(/_error$/, "")) || needle.includes(normalized)) return kind;
    }
  }
  if (status && KIND_BY_STATUS[status]) return KIND_BY_STATUS[status];
  return "unknown";
}

/** A JSON object with the fields providers actually use for errors. */
function extractErrorPayload(value: unknown): { code: string | null; message: string; requestId: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const nested = typeof record.error === "object" && record.error !== null
    ? (record.error as Record<string, unknown>)
    : null;
  const container = nested ?? record;

  const codeCandidates = [container.type, container.code, record.type, record.code, container.status];
  const code = codeCandidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? null;

  const messageCandidates = [container.message, record.message, container.detail, record.detail, container.error];
  const message = messageCandidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    ?? "";

  const requestIdCandidates = [record.request_id, record.requestId, container.request_id, container.requestId];
  const requestId = requestIdCandidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? null;

  if (!code && !message && !requestId) return null;
  return { code, message, requestId };
}

/**
 * Recognises `Error: <status> <json>` and equivalents.
 *
 * @returns null when the text is not a provider failure, so callers can leave
 * ordinary errors and assistant text untouched.
 */
export function parseProviderError(text: string): ProviderError | null {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `Error: 402 {…}` — an optional `<Word>Error:` prefix, an optional leading
  // status, then the provider's own body. The prefix and the body together are
  // what make this a provider failure: "502 Bad Gateway" on its own, or an
  // assistant answer that merely mentions a status, must not match.
  const match = trimmed.match(/^([A-Za-z]*Error:\s*)?([1-5]\d\d)?[:\s]*([\s\S]*)$/);
  if (!match) return null;
  const hasPrefix = match[1] !== undefined;
  const status = match[2] ? Number(match[2]) : null;
  const body = (match[3] ?? "").trim();
  const isJsonBody = body.startsWith("{") || body.startsWith("[");

  if (!hasPrefix && !isJsonBody) return null;

  let payload: { code: string | null; message: string; requestId: string | null } | null = null;
  if (isJsonBody) {
    try {
      payload = extractErrorPayload(JSON.parse(body));
    } catch {
      // Truncated or non-JSON body: the status alone still identifies the class.
      payload = null;
    }
  }

  if (!payload && status === null) return null;
  if (!payload) {
    return {
      status,
      code: null,
      message: body,
      requestId: null,
      kind: kindFor(null, status),
      raw: trimmed,
    };
  }

  return {
    status,
    code: payload.code,
    message: payload.message,
    requestId: payload.requestId,
    kind: kindFor(payload.code, status),
    raw: trimmed,
  };
}

/** The i18n key describing a kind. */
export function providerErrorKindKey(kind: ProviderErrorKind): string {
  return `chat.providerError.${kind}`;
}
