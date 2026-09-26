"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import { ConfigButton } from "./SettingsUi";

/**
 * Version and update status for this installation.
 *
 * Three questions, in one place: is there a newer Pi Web, is there a newer pi
 * SDK, and are the installed plugins behind. How the update is applied depends on
 * the deployment — a container is rebuilt on the host, an npm install is updated
 * with npm, a checkout with git — so the page prints the commands for the mode it
 * detected, and only offers the in-container path when the operator opted in
 * with `PI_WEB_ALLOW_SELF_UPDATE=1`.
 */

interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  checkedAt: number;
  fromCache: boolean;
  disabled: boolean;
  autoCheckDisabled: boolean;
  registry: string;
  error?: string;
}

interface DeploymentInfo {
  mode: "docker" | "npm" | "source";
  selfUpdateAvailable: boolean;
  selfUpdateEnabled: boolean;
  releasesDirectory: string;
  instructions: string[];
}

interface PluginUpdate {
  source: string;
  scope: string;
  displayName: string;
  type: string;
  state: string;
  message?: string;
}

interface PiAgentResponse {
  runtime: { version: string; latest: string | null; newer: boolean; checkedAt: number | null };
  cli: { via: "path" | "bundled" | "data-dir" | null; path: string | null; version: string | null };
  installTarget: string;
  deployment: { mode: "docker" | "npm" | "source" };
  hostCommand: string | null;
}

interface UpdatesResponse {
  app: AppUpdateStatus;
  runtime: { piVersion: string; nodeVersion: string; platform: string };
  deployment: DeploymentInfo;
  releases: string[];
  runningRelease: boolean;
  plugins: { checked: boolean; updates: PluginUpdate[]; error?: string };
}

/**
 * Version and update status.
 *
 * Embedded in the settings panel and standalone at `/updates`; the header and the
 * page shell only exist in the standalone host.
 */
export function UpdatesSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<UpdatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  /** The pi agent: runtime SDK + the pi CLI on this server. */
  const [piAgent, setPiAgent] = useState<PiAgentResponse | null>(null);
  const [piBusy, setPiBusy] = useState(false);
  const [piNotice, setPiNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async (options: { check?: boolean; plugins?: boolean } = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (options.check) params.set("check", "1");
      if (options.plugins) params.set("plugins", "1");
      const response = await fetch(`/api/updates?${params}`, { headers: { Accept: "application/json" } });
      const body = await response.json() as UpdatesResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData(body);
    } catch (cause) {
      setNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPi = useCallback(async (check = false) => {
    try {
      const response = await fetch(`/api/updates/pi${check ? "?check=1" : ""}`, { headers: { Accept: "application/json" } });
      const body = await response.json() as PiAgentResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setPiAgent(body);
    } catch (cause) {
      setPiNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);

  useEffect(() => { void load(); void loadPi(); }, [load, loadPi]);

  /**
   * Installs or updates the pi CLI into the data directory. The runtime SDK is
   * deliberately not touched here — it follows the application.
   */
  const installPi = async () => {
    if (piBusy) return;
    setPiBusy(true);
    setPiNotice(null);
    try {
      const response = await fetch("/api/updates/pi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: piAgent?.cli?.path ? "update" : "install" }),
      });
      const body = await response.json() as { ok?: boolean; path?: string; version?: string | null; message?: string; error?: string };
      if (!response.ok || !body.ok) {
        setPiNotice({ ok: false, message: body.message ?? body.error ?? `HTTP ${response.status}` });
        return;
      }
      setPiNotice({ ok: true, message: t("updates.piInstalledAt", { path: body.path ?? "", version: body.version ?? "" }) });
      await loadPi();
    } catch (cause) {
      setPiNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPiBusy(false);
    }
  };

  const action = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setNotice(null);
    try {
      const response = await fetch("/api/updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as {
        error?: string; message?: string; version?: string; restartRequired?: boolean; output?: string;
        instructions?: string[];
      };
      if (!response.ok) {
        setNotice({ ok: false, message: result.message ?? result.error ?? `HTTP ${response.status}` });
        return;
      }
      if (result.restartRequired) {
        setNotice({ ok: true, message: t("updates.restartRequired", { version: result.version ?? "" }) });
      } else {
        setNotice({ ok: true, message: t("updates.done") });
      }
      await load({ plugins: false });
    } catch (cause) {
      setNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };

  const app = data?.app;
  const deployment = data?.deployment;
  const pluginUpdates = data?.plugins.updates ?? [];
  const pendingPlugins = pluginUpdates.filter((update) => update.state === "update-available");

  const stateLabel = (state: string) => {
    const key = `updates.pluginState.${state}`;
    const translated = t(key);
    return translated === key ? state : translated;
  };

  const content = (
    <div className="settings-general">
      {notice && (
        <p className={`settings-notice ${notice.ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
          {notice.message}
        </p>
      )}

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("updates.appHeading")}</h3>
        <dl className="settings-definition">
          <dt>{t("updates.current")}</dt>
          <dd><code>{app?.currentVersion ?? "…"}</code></dd>
          <dt>{t("updates.latest")}</dt>
          <dd>
            <code>{app?.latestVersion ?? "…"}</code>{" "}
            {app?.updateAvailable
              ? <span className="settings-chip is-current">{t("updates.available")}</span>
              : <span className="settings-chip">{t("updates.upToDate")}</span>}
          </dd>
          <dt>{t("updates.checkedAt")}</dt>
          <dd>{app?.checkedAt ? formatUpdatedTime(app.checkedAt, locale as never) : t("user.never")}</dd>
          <dt>{t("updates.registry")}</dt>
          <dd><code>{app?.registry ?? "…"}</code></dd>
        </dl>
        {app?.autoCheckDisabled && <p className="settings-general-description">{t("updates.checkDisabled")}</p>}
        {app?.error && <p className="settings-notice is-error">{t("updates.checkFailed", { message: app.error })}</p>}
        <div className="settings-table-actions">
          <ConfigButton variant="secondary" disabled={loading} onClick={() => void load({ check: true })}>
            {t("updates.checkNow")}
          </ConfigButton>
          {app?.releaseUrl && (
            <a className="market-link" href={app.releaseUrl} target="_blank" rel="noopener noreferrer">
              {t("updates.releaseNotes")}
            </a>
          )}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("updates.howHeading")}</h3>
        <p className="settings-general-description">
          {t(`updates.mode.${deployment?.mode ?? "source"}`)}
        </p>
        {deployment && (
          <pre className="settings-recovery-codes">{deployment.instructions.join("\n")}</pre>
        )}
        {deployment?.selfUpdateAvailable && (
          <div className="settings-table-actions">
            <ConfigButton
              variant="danger"
              disabled={!deployment.selfUpdateEnabled || busy !== null || !app?.updateAvailable}
              onClick={() => void action({ action: "self-update", target: "latest" }, "self")}
              title={deployment.selfUpdateEnabled ? undefined : t("updates.selfDisabledHint")}
            >
              {busy === "self" ? t("updates.selfRunning") : t("updates.selfUpdate")}
            </ConfigButton>
            {!deployment.selfUpdateEnabled && (
              <span className="settings-general-description">{t("updates.selfDisabledHint")}</span>
            )}
          </div>
        )}
        {deployment?.selfUpdateEnabled && data?.runningRelease && (
          <div className="settings-table-actions">
            <ConfigButton
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void action({ action: "use-image-build", restart: true }, "image")}
            >
              {t("updates.useImageBuild")}
            </ConfigButton>
          </div>
        )}
        {deployment && data && data.releases.length > 0 && (
          <div className="settings-table-wrap">
<table className="settings-table">
            <thead>
              <tr>
                <th>{t("updates.installedReleases")}</th>
                <th aria-label={t("updates.rollback")} />
              </tr>
            </thead>
            <tbody>
              {data.releases.map((version) => (
                <tr key={version}>
                  <td><code>{version}</code></td>
                  <td>
                    <ConfigButton
                      variant="secondary"
                      size="small"
                      disabled={busy !== null || version === app?.currentVersion}
                      onClick={() => void action({ action: "rollback", version, restart: true }, `rollback-${version}`)}
                    >
                      {t("updates.rollback")}
                    </ConfigButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("updates.runtimeHeading")}</h3>
        <dl className="settings-definition">
          <dt>pi SDK</dt>
          <dd><code>{data?.runtime.piVersion ?? "…"}</code></dd>
          <dt>Node.js</dt>
          <dd><code>{data?.runtime.nodeVersion ?? "…"}</code></dd>
          <dt>{t("updates.platform")}</dt>
          <dd><code>{data?.runtime.platform ?? "…"}</code></dd>
        </dl>
        <p className="settings-general-description">{t("updates.runtimeHint")}</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("updates.piAgentHeading")}</h3>
        <dl className="settings-definition">
          <dt>{t("updates.piRuntime")}</dt>
          <dd>
            <code>{piAgent?.runtime.version ?? "…"}</code>
            {piAgent?.runtime.newer && (
              <span className="settings-chip">{t("updates.piNewer", { version: piAgent.runtime.latest ?? "" })}</span>
            )}
          </dd>
          <dt>{t("updates.piCli")}</dt>
          <dd>
            {piAgent?.cli?.path
              ? <code>{piAgent.cli.path} (v{piAgent.cli.version})</code>
              : t("updates.piCliMissing")}
          </dd>
        </dl>
        <p className="settings-general-description">
          {t("updates.piAgentHint", { target: piAgent?.installTarget ?? "" })}
        </p>
        {piAgent?.deployment.mode === "docker" && piAgent.hostCommand && (
          <p className="settings-general-description">
            {t("updates.piHostNote", { command: piAgent.hostCommand })}
          </p>
        )}
        {piNotice && (
          <p className={`settings-notice ${piNotice.ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
            {piNotice.message}
          </p>
        )}
        <div className="settings-table-actions">
          {piAgent?.cli?.path
            ? (
              <ConfigButton
                variant={piAgent.cli.version !== piAgent.runtime.latest && piAgent.runtime.latest ? "primary" : "secondary"}
                disabled={piBusy || piAgent.cli.version === piAgent.runtime.latest || !piAgent.runtime.latest}
                onClick={() => void installPi()}
              >
                {piBusy
                  ? t("updates.piUpdating")
                  : (piAgent.cli.version !== piAgent.runtime.latest && piAgent.runtime.latest)
                    ? t("updates.piCliUpdate")
                    : t("updates.piCliUpToDate")}
              </ConfigButton>
            )
            : (
              <ConfigButton variant="primary" disabled={piBusy} onClick={() => void installPi()}>
                {piBusy ? t("updates.piInstalling") : t("updates.piCliInstall")}
              </ConfigButton>
            )}
          <ConfigButton variant="ghost" disabled={piBusy} onClick={() => void loadPi(true)}>
            {t("updates.piCheck")}
          </ConfigButton>
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("updates.pluginsHeading")}</h3>
        <p className="settings-general-description">{t("updates.pluginsHint")}</p>
        <div className="settings-table-actions">
          <ConfigButton variant="secondary" disabled={loading} onClick={() => void load({ plugins: true })}>
            {t("updates.checkPlugins")}
          </ConfigButton>
          <ConfigButton
            variant="primary"
            disabled={busy !== null || pendingPlugins.length === 0}
            onClick={() => void action({ action: "update-all-plugins" }, "plugins")}
          >
            {t("updates.updateAllPlugins", { count: pendingPlugins.length })}
          </ConfigButton>
        </div>
        {data?.plugins.error && <p className="settings-notice is-error">{data.plugins.error}</p>}
        {data?.plugins.checked && pluginUpdates.length === 0 && !data.plugins.error && (
          <p className="settings-general-description">{t("updates.noPlugins")}</p>
        )}
        {pluginUpdates.length > 0 && (
          <div className="settings-table-wrap">
<table className="settings-table">
            <thead>
              <tr>
                <th>{t("updates.pluginColumn")}</th>
                <th>{t("updates.pluginScope")}</th>
                <th>{t("updates.pluginState")}</th>
              </tr>
            </thead>
            <tbody>
              {pluginUpdates.map((update) => (
                <tr key={`${update.scope}:${update.source}`}>
                  <td>{update.displayName || update.source}</td>
                  <td>{update.scope}</td>
                  <td>
                    <span className={`settings-chip${update.state === "update-available" ? " is-current" : ""}`}>
                      {stateLabel(update.state)}
                    </span>
                    {update.message && <div className="settings-general-description">{update.message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );

  if (embedded) return content;

  return (
    <div className="settings-page-host">
      <div className="settings-page-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("updates.title")}</strong>
          <Link className="settings-page-link" href="/market">{t("market.title")}</Link>
          <Link className="settings-page-link" href="/">{t("user.back")}</Link>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">{content}</div>
        </main>
      </div>
    </div>
  );
}

/** Standalone host at `/updates`. */
export function UpdatesPage() {
  return <UpdatesSettings />;
}
