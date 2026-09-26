import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { isAccountConfigured } from "@/lib/auth-store";
import { getDatabase } from "@/lib/db";
import { getSetupCode } from "@/lib/init-setup";

/**
 * Announce the first-run setup code as soon as the server starts.
 *
 * The code is what gates `/init`, and the documented way to find it is the log
 * (`docker logs pi-web`). Generating it lazily on the first status request would
 * mean an operator who follows those instructions sees nothing until they open
 * the page in a browser first.
 */
function announceFirstRunSetup(): void {
  if (process.env.PI_WEB_PASSWORD) return;
  try {
    if (isAccountConfigured(getDatabase())) return;
  } catch (error) {
    console.warn(
      "[pi-web] Could not read the account database at startup: "
      + (error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  getSetupCode();
}

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  announceFirstRunSetup();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
