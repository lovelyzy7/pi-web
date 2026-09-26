"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import { ConfigButton } from "./SettingsUi";

/**
 * Account centre rendered at /user.
 *
 * Reuses the settings dialog classes so the full-page host looks exactly like
 * the modal the app already opens, and keeps every write behind an explicit
 * confirmation step because each one ends sessions.
 */

type Tab = "overview" | "password" | "totp" | "tokens" | "devices" | "audit";

interface UserSessionView {
  id: string;
  current?: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  authMethod: string;
  ip: string | null;
  userAgent: string | null;
}

interface UserProfile {
  mode: "account" | "environment";
  username: string;
  displayName: string;
  createdAt?: number;
  passwordChangedAt?: number | null;
  lastLoginAt?: number | null;
  totpEnabled?: boolean;
  sessionMaxAgeMs?: number;
  session: UserSessionView | null;
}

interface TotpState {
  enabled: boolean;
  pending: boolean;
  confirmedAt: number | null;
  remainingRecoveryCodes: number;
}

interface ApiTokenView {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface AuditEvent {
  id: number;
  ts: number;
  kind: string;
  result: string;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

const WEAK_PASSWORD_KEYS: Record<string, string> = {
  "too-short": "init.weak.too-short",
  "too-long": "init.weak.too-long",
  "repeated": "init.weak.repeated",
  "common": "init.weak.common",
  "contains-username": "init.weak.contains-username",
  "needs-more-variety": "init.weak.needs-more-variety",
};

const AUDIT_KINDS = ["setup", "login", "logout", "password", "totp", "token", "throttle"] as const;

async function readJson<T>(response: Response): Promise<T & { error?: string; reason?: string }> {
  return await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
}

function formatClient(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const match = /(Firefox|Edg|Chrome|Safari|curl|node|python|Go-http-client)[/\s]?([\d.]*)/i.exec(userAgent);
  if (match) return match[2] ? `${match[1]} ${match[2]}` : match[1];
  return userAgent.split(" ").slice(0, 2).join(" ");
}

/**
 * Account centre.
 *
 * Rendered embedded in the settings panel (one section, like Models) and
 * standalone at `/user`, where the page shell adds a header and a back link.
 * Both hosts share every control below.
 */
export function AccountSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<UserSessionView[] | null>(null);
  const [totp, setTotp] = useState<TotpState | null>(null);
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [auditFilter, setAuditFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProfile = useCallback(async () => {
    const response = await fetch("/api/user", { headers: { Accept: "application/json" } });
    if (response.status === 409) {
      window.location.replace("/init");
      return null;
    }
    const body = await readJson<UserProfile>(response);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setProfile(body);
    return body;
  }, []);

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/user/sessions", { headers: { Accept: "application/json" } });
    const body = await readJson<{ sessions: UserSessionView[] }>(response);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setSessions(body.sessions ?? []);
  }, []);

  const loadTotp = useCallback(async () => {
    const response = await fetch("/api/user/totp", { headers: { Accept: "application/json" } });
    const body = await readJson<TotpState>(response);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setTotp(body);
  }, []);

  const loadTokens = useCallback(async () => {
    const response = await fetch("/api/user/tokens", { headers: { Accept: "application/json" } });
    const body = await readJson<{ tokens: ApiTokenView[] }>(response);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setTokens(body.tokens ?? []);
  }, []);

  const loadEvents = useCallback(async (kind: string) => {
    const query = new URLSearchParams({ limit: "50" });
    if (kind) query.set("kind", kind);
    const response = await fetch(`/api/user/audit?${query}`, { headers: { Accept: "application/json" } });
    const body = await readJson<{ events: AuditEvent[] }>(response);
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setEvents(body.events ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadProfile();
        if (cancelled) return;
        await Promise.all([loadSessions(), loadEvents(""), loadTotp(), loadTokens()]);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadProfile, loadSessions, loadEvents, loadTotp, loadTokens]);

  const reload = async () => {
    setError("");
    try {
      await Promise.all([loadProfile(), loadSessions(), loadEvents(auditFilter), loadTotp(), loadTokens()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const logOut = async () => {
    await fetch("/api/web-auth", { method: "DELETE" }).catch(() => {});
    window.location.replace("/login");
  };

  const tabs: { id: Tab; label: string; requiresAccount: boolean }[] = [
    { id: "overview", label: t("user.tab.overview"), requiresAccount: false },
    { id: "password", label: t("user.tab.password"), requiresAccount: true },
    { id: "totp", label: t("user.tab.totp"), requiresAccount: true },
    { id: "tokens", label: t("user.tab.tokens"), requiresAccount: true },
    { id: "devices", label: t("user.tab.devices"), requiresAccount: true },
    { id: "audit", label: t("user.tab.audit"), requiresAccount: true },
  ];

  const accountMode = profile?.mode !== "environment";
  const activeTab = accountMode ? tab : "overview";

  const shell = (children: React.ReactNode) => embedded ? (
    <div className="settings-account">{children}</div>
  ) : (
    <div className="settings-page-host">
      <div className="settings-page-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("user.title")}</strong>
          <Link className="settings-page-link" href="/">{t("user.back")}</Link>
          <button
            type="button"
            onClick={() => void logOut()}
            className="config-close-button settings-dialog-close"
            title={t("auth.logOut")}
            aria-label={t("auth.logOut")}
          >×</button>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">{children}</div>
        </main>
      </div>
    </div>
  );

  return shell(
    <div className="settings-general">
      <nav aria-label={t("user.title")} className="settings-section-tabs settings-section-tabs-inline">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className="settings-section-tab"
            disabled={item.requiresAccount && !accountMode}
            title={!accountMode && item.requiresAccount ? t("user.mode.environment") : item.label}
            aria-current={activeTab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            <span>{item.label}</span>
          </button>
        ))}
        {accountMode && (
          <button type="button" className="settings-account-logout" onClick={() => void logOut()}>
            {t("auth.logOut")}
          </button>
        )}
      </nav>

      {error && <p className="settings-notice is-error" role="alert">{error}</p>}
      {loading && !profile && <p className="settings-general-description">{t("user.loading")}</p>}

      {profile && activeTab === "overview" && (
        <OverviewTab profile={profile} locale={locale} onRetry={() => void reload()} />
      )}
      {profile && accountMode && activeTab === "password" && (
        <PasswordTab onChanged={() => void reload()} />
      )}
      {profile && accountMode && activeTab === "totp" && (
        <TotpTab state={totp} onChanged={() => void reload()} />
      )}
      {profile && accountMode && activeTab === "tokens" && (
        <TokensTab tokens={tokens} onChanged={() => void reload()} />
      )}
      {profile && accountMode && activeTab === "devices" && (
        <DevicesTab locale={locale} sessions={sessions} onChanged={() => void reload()} />
      )}
      {profile && accountMode && activeTab === "audit" && (
        <AuditTab
          locale={locale}
          events={events}
          filter={auditFilter}
          onFilterChange={(kind) => { setAuditFilter(kind); void loadEvents(kind); }}
        />
      )}
    </div>,
  );
}

/** Standalone host at `/user`. */
export function UserPage() {
  return <AccountSettings />;
}

function timeText(value: number | null | undefined, locale: string, never: string): string {
  if (!value) return never;
  return formatUpdatedTime(value, locale as never);
}

function OverviewTab({
  profile,
  locale,
  onRetry,
}: {
  profile: UserProfile;
  locale: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.overview")}</h2>
      <p className="settings-general-description">
        {profile.mode === "environment" ? t("user.mode.environmentHint") : t("user.mode.account")}
      </p>
      <section className="settings-general-section">
        <dl className="settings-definition">
          <dt>{t("user.field.username")}</dt>
          <dd>{profile.username}</dd>
          <dt>{t("user.field.createdAt")}</dt>
          <dd>{timeText(profile.createdAt, locale, t("user.never"))}</dd>
          <dt>{t("user.field.lastLoginAt")}</dt>
          <dd>{timeText(profile.lastLoginAt, locale, t("user.never"))}</dd>
          <dt>{t("user.field.passwordChangedAt")}</dt>
          <dd>{timeText(profile.passwordChangedAt, locale, t("user.never"))}</dd>
          <dt>{t("user.field.sessionTtl")}</dt>
          <dd>
            {profile.sessionMaxAgeMs
              ? t("user.days", { count: Math.round(profile.sessionMaxAgeMs / 86_400_000) })
              : t("user.mode.environment")}
          </dd>
          {profile.session && (
            <>
              <dt>{t("user.field.sessionExpiresAt")}</dt>
              <dd>{timeText(profile.session.expiresAt, locale, t("user.never"))}</dd>
            </>
          )}
        </dl>
      </section>
      <section className="settings-general-section">
        <ConfigButton variant="secondary" onClick={onRetry}>{t("user.retry")}</ConfigButton>
      </section>
    </>
  );
}

function PasswordTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  const submit = async () => {
    if (newPassword !== confirmation) {
      setNotice({ kind: "error", message: t("init.mismatch") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/user/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await readJson<{ signedOutSessions?: number }>(response);
      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmation("");
        setNotice({ kind: "ok", message: t("user.password.changed") });
        onChanged();
        return;
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        setNotice({
          kind: "error",
          message: t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 }),
        });
        return;
      }
      if (body.error === "invalid_password") {
        setNotice({ kind: "error", message: t("user.password.invalidCurrent") });
        return;
      }
      if (body.error === "weak_password") {
        setNotice({
          kind: "error",
          message: t(WEAK_PASSWORD_KEYS[body.reason ?? ""] ?? "init.weak.unknown", { min: 10 }),
        });
        return;
      }
      setNotice({ kind: "error", message: t("user.password.failed") });
    } catch {
      setNotice({ kind: "error", message: t("user.password.failed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.password")}</h2>
      <p className="settings-general-description">{t("init.passwordHint", { min: 10, passphrase: 16 })}</p>
      {notice && (
        <p className={`settings-notice ${notice.kind === "ok" ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
          {notice.message}
        </p>
      )}
      <section className="settings-general-section">
        <div className="settings-field-grid">
          <div>
            <label htmlFor="user-current-password">{t("user.password.current")}</label>
            <input
              id="user-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              disabled={busy}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="user-new-password">{t("user.password.new")}</label>
            <input
              id="user-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              disabled={busy}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="user-confirm-password">{t("user.password.confirm")}</label>
            <input
              id="user-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
        </div>
      </section>
      <section className="settings-general-section">
        <ConfigButton
          variant="primary"
          disabled={busy || !currentPassword || !newPassword}
          onClick={() => void submit()}
        >
          {busy ? t("user.password.submitting") : t("user.password.submit")}
        </ConfigButton>
      </section>
    </>
  );
}

function DevicesTab({
  locale,
  sessions,
  onChanged,
}: {
  locale: string;
  sessions: UserSessionView[] | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const revoke = async (id: string, current?: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/user/sessions/${id}`, { method: "DELETE" });
      if (current) {
        window.location.replace("/login");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onChanged();
    } catch {
      setNotice(t("user.loadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/user/sessions", { method: "DELETE" });
      const body = await readJson<{ revoked?: number }>(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNotice(t("user.devices.revokedOthers", { count: body.revoked ?? 0 }));
      onChanged();
    } catch {
      setNotice(t("user.loadFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.devices")}</h2>
      <p className="settings-general-description">{t("user.devices.description")}</p>
      {notice && <p className="settings-notice is-ok" role="status">{notice}</p>}
      {sessions === null && <p className="settings-general-description">{t("user.loading")}</p>}
      {sessions !== null && sessions.length === 0 && (
        <p className="settings-general-description">{t("user.devices.empty")}</p>
      )}
      {sessions !== null && sessions.length > 0 && (
        <section className="settings-general-section">
          <div className="settings-table-wrap">
<table className="settings-table">
            <thead>
              <tr>
                <th>{t("user.devices.client")}</th>
                <th>{t("user.devices.ip")}</th>
                <th>{t("user.devices.lastSeenAt")}</th>
                <th>{t("user.devices.expiresAt")}</th>
                <th aria-label={t("user.devices.revoke")} />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    {session.current && <span className="settings-chip is-current">{t("user.devices.current")}</span>}{" "}
                    {formatClient(session.userAgent) ?? t("user.devices.unknownClient")}
                  </td>
                  <td>{session.ip ?? "—"}</td>
                  <td>{timeText(session.lastSeenAt, locale, t("user.never"))}</td>
                  <td>{timeText(session.expiresAt, locale, t("user.never"))}</td>
                  <td>
                    <ConfigButton
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => void revoke(session.id, session.current)}
                    >
                      {t("user.devices.revoke")}
                    </ConfigButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="settings-table-actions">
            <ConfigButton variant="danger" disabled={busy} onClick={() => void revokeOthers()}>
              {t("user.devices.revokeOthers")}
            </ConfigButton>
          </div>
        </section>
      )}
    </>
  );
}

function AuditTab({
  locale,
  events,
  filter,
  onFilterChange,
}: {
  locale: string;
  events: AuditEvent[] | null;
  filter: string;
  onFilterChange: (kind: string) => void;
}) {
  const { t } = useI18n();
  const kindLabel = (kind: string) => {
    const key = `user.audit.kind.${kind}`;
    const translated = t(key);
    return translated === key ? kind : translated;
  };
  const resultLabel = (result: string) => {
    const key = `user.audit.result.${result}`;
    const translated = t(key);
    return translated === key ? result : translated;
  };

  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.audit")}</h2>
      <p className="settings-general-description">{t("user.audit.description")}</p>
      <section className="settings-general-section">
        <label className="settings-general-description" htmlFor="user-audit-filter">{t("user.audit.filter.all")}</label>
        <select
          id="user-audit-filter"
          className="settings-select"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
        >
          <option value="">{t("user.audit.filter.all")}</option>
          {AUDIT_KINDS.map((kind) => (
            <option key={kind} value={kind}>{kindLabel(kind)}</option>
          ))}
        </select>
      </section>
      {events === null && <p className="settings-general-description">{t("user.loading")}</p>}
      {events !== null && events.length === 0 && (
        <p className="settings-general-description">{t("user.audit.empty")}</p>
      )}
      {events !== null && events.length > 0 && (
        <section className="settings-general-section">
          <div className="settings-table-wrap">
<table className="settings-table">
            <thead>
              <tr>
                <th>{t("user.audit.time")}</th>
                <th>{t("user.audit.kind")}</th>
                <th>{t("user.audit.result")}</th>
                <th>{t("user.devices.ip")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatUpdatedTime(event.ts, locale as never)}</td>
                  <td>{kindLabel(event.kind)}</td>
                  <td>
                    <span className={`settings-chip${event.result === "ok" ? "" : " is-fail"}`}>
                      {resultLabel(event.result)}
                    </span>
                  </td>
                  <td>{event.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}
    </>
  );
}

function TotpTab({ state, onChanged }: { state: TotpState | null; onChanged: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  const post = async (method: string, body: unknown) => {
    const response = await fetch("/api/user/totp", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      response,
      body: await readJson<{ secret?: string; qrSvg?: string; recoveryCodes?: string[] }>(response),
    };
  };

  const start = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { response, body } = await post("POST", { password });
      if (response.status === 401) {
        setNotice({ kind: "error", message: t("user.password.invalidCurrent") });
        return;
      }
      if (!response.ok) {
        setNotice({ kind: "error", message: t("user.totp.setupFailed") });
        return;
      }
      if (!body.secret || !body.qrSvg) {
        setNotice({ kind: "error", message: t("user.totp.setupFailed") });
        return;
      }
      setEnrollment({ secret: body.secret, qrSvg: body.qrSvg });
      setPassword("");
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("user.totp.setupFailed") });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!/^[\d\s-]{6,}$/.test(code)) {
      setNotice({ kind: "error", message: t("user.totp.codeRequired") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { response, body } = await post("PUT", { code });
      if (!response.ok) {
        setNotice({ kind: "error", message: t("auth.totpFailed") });
        return;
      }
      setRecoveryCodes(body.recoveryCodes ?? []);
      setEnrollment(null);
      setCode("");
      setNotice({ kind: "ok", message: t("user.totp.enabledNotice") });
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("auth.totpFailed") });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { response } = await post("DELETE", { password, code });
      if (!response.ok) {
        setNotice({ kind: "error", message: response.status === 401 ? t("auth.totpFailed") : t("user.loadFailed") });
        return;
      }
      setNotice({ kind: "ok", message: t("user.totp.disabledNotice") });
      setPassword("");
      setCode("");
      setRecoveryCodes(null);
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("user.loadFailed") });
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { response, body } = await post("PATCH", { password });
      if (response.status === 401) {
        setNotice({ kind: "error", message: t("user.password.invalidCurrent") });
        return;
      }
      if (!response.ok) {
        setNotice({ kind: "error", message: t("user.loadFailed") });
        return;
      }
      setRecoveryCodes(body.recoveryCodes ?? []);
      setPassword("");
      setNotice({ kind: "ok", message: t("user.totp.regenerated") });
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("user.loadFailed") });
    } finally {
      setBusy(false);
    }
  };

  const status = state?.enabled
    ? t("user.totp.enabledLabel")
    : state?.pending
      ? t("user.totp.pendingLabel")
      : t("user.totp.disabledLabel");

  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.totp")}</h2>
      <p className="settings-general-description">{t("user.totp.description")}</p>
      {notice && (
        <p className={`settings-notice ${notice.kind === "ok" ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
          {notice.message}
        </p>
      )}
      <section className="settings-general-section">
        <dl className="settings-definition">
          <dt>{t("user.tab.totp")}</dt>
          <dd>
            <span className="settings-chip">{status}</span>
          </dd>
          {state?.enabled && (
            <>
              <dt>{t("user.totp.recoveryTitle")}</dt>
              <dd>{t("user.totp.remaining", { count: state.remainingRecoveryCodes })}</dd>
            </>
          )}
        </dl>
      </section>

      {recoveryCodes && (
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("user.totp.recoveryTitle")}</h3>
          <p className="settings-general-description">{t("user.totp.recoveryHint")}</p>
          <pre className="settings-recovery-codes">{recoveryCodes.join("\n")}</pre>
          <ConfigButton variant="secondary" onClick={() => setRecoveryCodes(null)}>
            {t("common.ok")}
          </ConfigButton>
        </section>
      )}

      {!state?.enabled && !enrollment && (
        <section className="settings-general-section">
          <p className="settings-general-description">{t("user.totp.passwordHint")}</p>
          <div className="settings-field-grid">
            <div>
              <label htmlFor="totp-enable-password">{t("user.password.current")}</label>
              <input
                id="totp-enable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <div className="settings-table-actions">
            <ConfigButton variant="primary" disabled={busy || !password} onClick={() => void start()}>
              {t("user.totp.start")}
            </ConfigButton>
          </div>
        </section>
      )}

      {enrollment && (
        <section className="settings-general-section">
          <p className="settings-general-description">{t("user.totp.scanHint")}</p>
          <div className="settings-totp-qr" dangerouslySetInnerHTML={{ __html: enrollment.qrSvg }} />
          <dl className="settings-definition">
            <dt>{t("user.totp.secret")}</dt>
            <dd><code>{enrollment.secret}</code></dd>
          </dl>
          <p className="settings-general-description">{t("user.totp.confirmHint")}</p>
          <div className="settings-field-grid">
            <div>
              <label htmlFor="totp-confirm-code">{t("auth.totpCode")}</label>
              <input
                id="totp-confirm-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          </div>
          <div className="settings-table-actions">
            <ConfigButton variant="primary" disabled={busy || !code} onClick={() => void confirm()}>
              {t("user.totp.confirm")}
            </ConfigButton>
            <ConfigButton variant="secondary" disabled={busy} onClick={() => { setEnrollment(null); setCode(""); }}>
              {t("user.totp.restart")}
            </ConfigButton>
          </div>
        </section>
      )}

      {state?.enabled && (
        <section className="settings-general-section">
          <p className="settings-general-description">{t("user.totp.passwordHint")}</p>
          <div className="settings-field-grid">
            <div>
              <label htmlFor="totp-password">{t("user.password.current")}</label>
              <input
                id="totp-password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="totp-disable-code">{t("auth.totpCode")}</label>
              <input
                id="totp-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          </div>
          <div className="settings-table-actions">
            <ConfigButton variant="secondary" disabled={busy || !password} onClick={() => void regenerate()}>
              {t("user.totp.regenerate")}
            </ConfigButton>
            <ConfigButton variant="danger" disabled={busy || !password || !code} onClick={() => void disable()}>
              {t("user.totp.disable")}
            </ConfigButton>
          </div>
        </section>
      )}
    </>
  );
}

function TokensTab({ tokens, onChanged }: { tokens: ApiTokenView[] | null; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [password, setPassword] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  const create = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/user/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes: [scope],
          expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
          password,
        }),
      });
      const body = await readJson<{ token?: string }>(response);
      if (response.status === 401) {
        setNotice({ kind: "error", message: t("user.password.invalidCurrent") });
        return;
      }
      if (!response.ok || !body.token) {
        setNotice({ kind: "error", message: t("user.tokens.failed") });
        return;
      }
      setCreatedToken(body.token);
      setCopied(false);
      setName("");
      setPassword("");
      setExpiresInDays("");
      setNotice({ kind: "ok", message: t("user.tokens.created") });
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("user.tokens.failed") });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/user/tokens/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNotice({ kind: "ok", message: t("user.tokens.revoked") });
      onChanged();
    } catch {
      setNotice({ kind: "error", message: t("user.loadFailed") });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const scopeLabel = (value: string) => value === "full" ? t("user.tokens.scope.full") : t("user.tokens.scope.read");

  return (
    <>
      <h2 className="settings-general-title">{t("user.tab.tokens")}</h2>
      <p className="settings-general-description">{t("user.tokens.description")}</p>
      <p className="settings-general-description">{t("user.tokens.basicDisabled")}</p>
      {notice && (
        <p className={`settings-notice ${notice.kind === "ok" ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
          {notice.message}
        </p>
      )}

      {createdToken && (
        <section className="settings-general-section">
          <pre className="settings-recovery-codes">{createdToken}</pre>
          <div className="settings-table-actions">
            <ConfigButton variant="secondary" onClick={() => void copy()}>
              {copied ? t("user.tokens.copied") : t("user.tokens.copy")}
            </ConfigButton>
            <ConfigButton variant="ghost" onClick={() => setCreatedToken(null)}>
              {t("common.ok")}
            </ConfigButton>
          </div>
        </section>
      )}

      <section className="settings-general-section">
        <div className="settings-field-grid">
          <div>
            <label htmlFor="token-name">{t("user.tokens.name")}</label>
            <input
              id="token-name"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="token-scope">{t("user.tokens.scopes")}</label>
            <select
              id="token-scope"
              className="settings-select"
              value={scope}
              disabled={busy}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="read">{t("user.tokens.scope.read")}</option>
              <option value="full">{t("user.tokens.scope.full")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="token-expiry">{t("user.tokens.expiryLabel")}</label>
            <input
              id="token-expiry"
              inputMode="numeric"
              value={expiresInDays}
              disabled={busy}
              onChange={(event) => setExpiresInDays(event.target.value.replace(/[^\d]/g, ""))}
            />
          </div>
          <div>
            <label htmlFor="token-password">{t("user.password.current")}</label>
            <input
              id="token-password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        <div className="settings-table-actions">
          <ConfigButton variant="primary" disabled={busy || !password} onClick={() => void create()}>
            {busy ? t("user.tokens.creating") : t("user.tokens.create")}
          </ConfigButton>
        </div>
      </section>

      {tokens !== null && tokens.length > 0 && (
        <section className="settings-general-section">
          <div className="settings-table-wrap">
<table className="settings-table">
            <thead>
              <tr>
                <th>{t("user.tokens.name")}</th>
                <th>{t("user.tokens.prefix")}</th>
                <th>{t("user.tokens.scopes")}</th>
                <th>{t("user.tokens.lastUsedAt")}</th>
                <th>{t("user.tokens.expiresAt")}</th>
                <th aria-label={t("user.tokens.revoke")} />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td><code>{token.prefix}…</code></td>
                  <td>{token.scopes.map(scopeLabel).join(", ")}</td>
                  <td>{timeText(token.lastUsedAt, locale, t("user.never"))}</td>
                  <td>{timeText(token.expiresAt, locale, t("user.never"))}</td>
                  <td>
                    {token.revokedAt === null
                      ? (
                        <ConfigButton variant="danger" size="small" disabled={busy} onClick={() => void revoke(token.id)}>
                          {t("user.tokens.revoke")}
                        </ConfigButton>
                      )
                      : <span className="settings-chip">{t("user.tokens.revoked")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}
      {tokens !== null && tokens.length === 0 && (
        <p className="settings-general-description">{t("user.tokens.empty")}</p>
      )}
    </>
  );
}
