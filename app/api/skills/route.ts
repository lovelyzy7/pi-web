import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectCwdNotice, projectCwdRefusalStatus, resolveProjectCwd } from "@/lib/project-cwd";
import { getAgentDir as agentDirOf } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const requested = searchParams.get("cwd");

  try {
    // The global scope (agent dir, installed packages) is listed even when the
    // selected project is not on this machine — a container started with the
    // host's sessions knows paths the image never had, and refusing the whole
    // request hid every global skill behind "Access denied".
    const scope = await resolveProjectCwd(requested, { allowedRoots: await getAllowedFileRoots() });
    const refusal = projectCwdRefusalStatus(scope.status);
    if (refusal) return NextResponse.json({ error: "Access denied" }, { status: refusal });
    if (!requested && scope.status === "none") {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }

    const skills = await loadSkillsWithInstallInfo(scope.cwd ?? globalSkillScope());
    return NextResponse.json({ ...skills, cwdNotice: projectCwdNotice(scope) ?? undefined });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * Where the loader looks when there is no project: the agent directory itself,
 * which is what makes package and global skills visible.
 */
function globalSkillScope(): string {
  return agentDirOf();
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });
    const allowedRoots = new Set(await getAllowedFileRoots());
    allowedRoots.add(getAgentDir());
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
    if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
