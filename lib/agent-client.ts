// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/**
 * The session's working directory is gone on the server (usually a container
 * started without that project mounted). The prompt was definitively rejected:
 * there is nothing to wait for, so the UI reports it immediately.
 */
export function isCwdMissingCommandError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError && error.code === "cwd_missing";
}

/**
 * The session directory a failed start named, from either error path: the POST
 * reply (`AgentCommandError`) or the event stream (`AgentEventConnectionError`).
 */
export function cwdMissingFromError(error: unknown): { cwd: string } | null {
  if (typeof error !== "object" || error === null) return null;
  if ((error as { code?: unknown }).code !== "cwd_missing") return null;
  const cwd = (error as { cwd?: unknown }).cwd;
  return { cwd: typeof cwd === "string" ? cwd : "" };
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
