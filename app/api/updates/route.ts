import { NextRequest } from "next/server";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  VERSION as piVersion,
} from "@earendil-works/pi-coding-agent";
import {
  deploymentInfo,
  getAppUpdateStatus,
} from "@/lib/app-update-service";
import { checkPluginUpdates } from "@/lib/plugin-updates";
import { getProjectTrustStatus } from "@/lib/project-trust";
import {
  applySelfUpdate,
  hasCurrentRelease,
  listInstalledReleases,
  planSelfUpdate,
  rollbackTo,
  switchToImageBuild,
} from "@/lib/self-update";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * Everything the updates page needs in one request: this build, the pi SDK it
 * pins, the deployment shape, and — only when asked — plugin updates, which cost
 * one `npm view` per package.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: "Untrusted API request" }, 403);
  }

  const force = request.nextUrl.searchParams.get("check") === "1";
  const app = await getAppUpdateStatus({ force });
  const deployment = deploymentInfo();

  let plugins: { checked: boolean; updates: unknown[]; error?: string } = { checked: false, updates: [] };
  if (request.nextUrl.searchParams.get("plugins") === "1") {
    try {
      const cwd = request.nextUrl.searchParams.get("cwd") || getAgentDir();
      plugins = { checked: true, updates: await checkPluginUpdates(cwd) };
    } catch (error) {
      plugins = {
        checked: true,
        updates: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return json({
    app,
    runtime: {
      piVersion,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    deployment,
    releases: listInstalledReleases(deployment.releasesDirectory),
    runningRelease: hasCurrentRelease(deployment.releasesDirectory),
    plugins,
  });
}

/**
 * Update actions. Preparing a release is safe to run repeatedly; only the
 * symlink switch changes what starts next, and only a restart changes what runs.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: "Untrusted API request" }, 403);
  }

  const body = await request.json().catch(() => null) as
    | { action?: unknown; target?: unknown; version?: unknown; restart?: unknown; cwd?: unknown }
    | null;
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "check") {
    return json({ app: await getAppUpdateStatus({ force: true }) });
  }

  if (action === "use-image-build") {
    const result = switchToImageBuild();
    if (!result.ok) return json({ error: "reset_failed", message: result.message }, 400);
    if (body?.restart === true) scheduleRestart();
    return json({ ok: true, restartRequired: true, version: "image" });
  }

  if (action === "rollback") {
    const version = typeof body?.version === "string" ? body.version : "";
    const result = rollbackTo(version);
    if (!result.ok) return json({ error: "rollback_failed", message: result.message }, 400);
    if (body?.restart === true) scheduleRestart();
    return json(result);
  }

  if (action === "update-all-plugins") {
    // Project-scoped packages belong to their project's Plugins panel; this
    // updates the global set, which is what the updates page lists.
    const cwd = typeof body?.cwd === "string" && body.cwd ? body.cwd : getAgentDir();
    const agentDir = getAgentDir();
    const trust = getProjectTrustStatus(cwd, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trust.trusted });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    try {
      await manager.update(undefined);
      return json({ ok: true });
    } catch (error) {
      return json({ error: "update_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "self-update") {
    const deployment = deploymentInfo();
    if (!deployment.selfUpdateEnabled) {
      return json({
        error: "self_update_disabled",
        message: "Set PI_WEB_ALLOW_SELF_UPDATE=1 to let this server replace its own code, or update the image on the host.",
        instructions: deployment.instructions,
      }, 409);
    }

    const plan = await planSelfUpdate({
      target: typeof body?.target === "string" ? body.target : undefined,
    });
    if (!plan) {
      return json({ error: "unknown_version", message: "That version is not published as a stable release." }, 400);
    }
    if (plan.blockedReason) {
      return json({ error: "node_incompatible", message: plan.blockedReason, plan }, 409);
    }

    const result = await applySelfUpdate(plan);
    if (!result.ok) return json({ error: "self_update_failed", ...result }, 500);
    if (body?.restart === true) scheduleRestart();
    return json({ ...result, plan: { targetVersion: plan.targetVersion, targetDirectory: plan.targetDirectory } });
  }

  return json({ error: "unknown_action" }, 400);
}

/**
 * Exits shortly after the response has been flushed. The container's restart
 * policy starts the entrypoint again, and the entrypoint resolves `current`, so
 * the new release is what comes back up.
 */
function scheduleRestart(): void {
  setTimeout(() => {
    console.log("[pi-web] Restarting to pick up the prepared release.");
    process.exit(0);
  }, 1_500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
