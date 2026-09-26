"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import { MarkdownBody } from "./MarkdownBody";
import { ConfigButton } from "./SettingsUi";
import { ConfigField } from "./SettingsUi";

/**
 * The package marketplace.
 *
 * The catalog comes from pi.dev (see `lib/market-catalog.ts`), while installation
 * goes through `/api/plugins`, which already owns the package manager, project
 * trust, and the settings file. The page therefore needs a project to install
 * into — that is the `cwd` the plugins API validates against the file-access
 * allow-list — even for a global install.
 */

interface MarketPackage {
  name: string;
  description: string;
  types: string[];
  downloads: number;
  publishedAt: number | null;
  author: string | null;
  npmUrl: string | null;
  repoUrl: string | null;
  downloadsText: string | null;
  publishedText: string | null;
}

interface MarketPackageDetail extends MarketPackage {
  version: string | null;
  installCommand: string | null;
  license: string | null;
  size: string | null;
  dependencies: string | null;
  securityNote: string | null;
  readme: string | null;
  pageUrl: string;
}

interface CatalogResponse {
  items: MarketPackage[];
  page: number;
  hasMore: boolean;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
}

const TYPES = ["", "extension", "skill", "theme", "prompt"] as const;
const SORTS = ["downloads", "recent", "name"] as const;

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

/**
 * Marketplace.
 *
 * Rendered embedded in the settings panel (where the panel already knows the
 * selected project) and standalone at `/market`, where the page shell adds a
 * header and the project has to be picked here.
 */
export function MarketSettings({
  embedded = false,
  cwd: cwdOverride = null,
}: {
  embedded?: boolean;
  cwd?: string | null;
} = {}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [pendingQuery, setPendingQuery] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]>("downloads");
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<MarketPackageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [cwd, setCwd] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [installBusy, setInstallBusy] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<{ ok: boolean; message: string } | null>(null);

  const loadCatalog = useCallback(async (next: { query: string; type: string; sort: string; page: number }) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: next.query, sort: next.sort, page: String(next.page) });
      if (next.type) params.set("type", next.type);
      const response = await fetch(`/api/market?${params}`, { headers: { Accept: "application/json" } });
      const body = await response.json() as CatalogResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setCatalog(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCatalog(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog({ query, type, sort, page });
  }, [loadCatalog, query, type, sort, page]);

  useEffect(() => {
    if (cwdOverride) {
      setCwd(cwdOverride);
      return;
    }
    const url = new URLSearchParams(window.location.search);
    const fromUrl = url.get("cwd");
    void fetch("/api/sessions", { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { sessions?: { cwd?: string }[] } | null) => {
        const found = [...new Set((data?.sessions ?? []).map((session) => session.cwd).filter(Boolean))] as string[];
        setProjects(found);
        setCwd(fromUrl || found[0] || "");
      })
      .catch(() => {});
  }, [cwdOverride]);

  const openDetail = async (name: string) => {
    setDetailLoading(true);
    setInstallLog(null);
    try {
      const response = await fetch(`/api/market?package=${encodeURIComponent(name)}`, {
        headers: { Accept: "application/json" },
      });
      const body = await response.json() as { item?: MarketPackageDetail; error?: string };
      if (!response.ok || !body.item) throw new Error(body.error ?? `HTTP ${response.status}`);
      setDetail(body.item);
    } catch (cause) {
      setInstallLog({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setDetailLoading(false);
    }
  };

  const install = async (name: string, version?: string | null) => {
    if (!cwd) {
      setInstallLog({ ok: false, message: t("market.needProject") });
      return;
    }
    setInstallBusy(name);
    setInstallLog(null);
    try {
      const response = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "install",
          source: `npm:${name}${version ? `@${version}` : ""}`,
          scope,
          cwd,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setInstallLog({ ok: true, message: t("market.installDone", { name }) });
    } catch (cause) {
      setInstallLog({ ok: false, message: t("market.installFailed", { message: cause instanceof Error ? cause.message : String(cause) }) });
    } finally {
      setInstallBusy(null);
    }
  };

  const items = useMemo(() => catalog?.items ?? [], [catalog]);
  const sortLabel = (value: string) =>
    value === "recent" ? t("market.sortRecent") : value === "name" ? t("market.sortName") : t("market.sortDownloads");
  const typeLabel = (value: string) => value ? t(`market.type.${value}`) : t("market.type.all");

  const body = (
    <div className="settings-general">
      <form
        className="market-toolbar"
        onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(pendingQuery); }}
      >
        <input
          className="settings-select market-search"
          value={pendingQuery}
          placeholder={t("market.searchPlaceholder")}
          onChange={(event) => setPendingQuery(event.target.value)}
          aria-label={t("market.searchPlaceholder")}
        />
        <select
          className="settings-select"
          value={type}
          aria-label={t("market.typeLabel")}
          onChange={(event) => { setPage(1); setType(event.target.value); }}
        >
          {TYPES.map((value) => <option key={value || "all"} value={value}>{typeLabel(value)}</option>)}
        </select>
        <select
          className="settings-select"
          value={sort}
          aria-label={t("market.sortLabel")}
          onChange={(event) => { setPage(1); setSort(event.target.value as (typeof SORTS)[number]); }}
        >
          {SORTS.map((value) => <option key={value} value={value}>{sortLabel(value)}</option>)}
        </select>
        <ConfigButton variant="secondary" size="small" disabled={!pendingQuery && !query}>
          {t("market.search")}
        </ConfigButton>
      </form>

      <p className="settings-general-description">
        {catalog
          ? t("market.resultMeta", {
              count: items.length,
              page: catalog.page,
              age: formatUpdatedTime(catalog.fetchedAt, locale as never),
              source: catalog.stale ? t("market.sourceStale") : t("market.sourceLive"),
            })
          : t("market.loading")}
      </p>

      {!embedded && (
        <div className="market-install-row">
          <ConfigField label={t("market.projectLabel")}>
            <select
              className="settings-select"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              aria-label={t("market.projectLabel")}
            >
              {projects.length === 0 && <option value="">{t("market.noProjects")}</option>}
              {projects.map((project) => <option key={project} value={project}>{project}</option>)}
            </select>
          </ConfigField>
          <ConfigField label={t("market.scopeLabel")}>
            <select
              className="settings-select"
              value={scope}
              onChange={(event) => setScope(event.target.value as "global" | "project")}
              aria-label={t("market.scopeLabel")}
            >
              <option value="global">{t("market.scopeGlobal")}</option>
              <option value="project">{t("market.scopeProject")}</option>
            </select>
          </ConfigField>
        </div>
      )}

      {embedded && (
        <div className="market-install-row">
          <ConfigField label={t("market.scopeLabel")}>
            <select
              className="settings-select"
              value={scope}
              onChange={(event) => setScope(event.target.value as "global" | "project")}
              aria-label={t("market.scopeLabel")}
            >
              <option value="global">{t("market.scopeGlobal")}</option>
              <option value="project">{t("market.scopeProject")}</option>
            </select>
          </ConfigField>
        </div>
      )}

      {installLog && (
        <p className={`settings-notice ${installLog.ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
          {installLog.message}
        </p>
      )}
      {error && <p className="settings-notice is-error" role="alert">{error}</p>}

      <section className="settings-general-section">
        {loading && items.length === 0 && <p className="settings-general-description">{t("market.loading")}</p>}
        {!loading && items.length === 0 && <p className="settings-general-description">{t("market.empty")}</p>}
        <ul className="market-grid">
          {items.map((item) => (
            <li key={item.name} className="market-card">
              <div className="market-card-head">
                <button type="button" className="market-card-name" onClick={() => void openDetail(item.name)}>
                  {item.name}
                </button>
                <span className="settings-chip">{item.types.join(", ") || "package"}</span>
              </div>
              <p className="market-card-desc">{item.description}</p>
              <div className="market-card-meta">
                <span>{item.author ?? t("market.unknownAuthor")}</span>
                <span>{item.downloads ? `${formatCount(item.downloads)}${t("market.perMonth")}` : (item.downloadsText ?? "")}</span>
                {(item.publishedText || item.publishedAt) && (
                  <span>{item.publishedText ?? formatUpdatedTime(item.publishedAt as number, locale as never)}</span>
                )}
              </div>
              <div className="market-card-actions">
                <ConfigButton
                  variant="primary"
                  size="small"
                  disabled={installBusy === item.name || !cwd}
                  onClick={() => void install(item.name)}
                >
                  {installBusy === item.name ? t("market.installing") : t("market.install")}
                </ConfigButton>
                <button type="button" className="market-link" onClick={() => void openDetail(item.name)}>
                  {t("market.details")}
                </button>
                {item.npmUrl && (
                  <a className="market-link" href={item.npmUrl} target="_blank" rel="noopener noreferrer">npm</a>
                )}
                {item.repoUrl && (
                  <a className="market-link" href={item.repoUrl} target="_blank" rel="noopener noreferrer">repo</a>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="settings-table-actions">
          <ConfigButton
            variant="secondary"
            size="small"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            {t("market.previous")}
          </ConfigButton>
          <ConfigButton
            variant="secondary"
            size="small"
            disabled={!catalog?.hasMore || loading}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("market.next")}
          </ConfigButton>
        </div>
      </section>
    </div>
  );

  const detailView = (detail || detailLoading) && (
    <div
      className={embedded ? "market-detail-inline" : "settings-dialog-backdrop"}
      role="dialog"
      aria-modal={embedded ? undefined : "true"}
      aria-label={detail?.name ?? t("market.details")}
      onClick={(event) => { if (!embedded && event.target === event.currentTarget) setDetail(null); }}
    >
      <div className={embedded ? "market-detail-inline-surface" : "settings-dialog-surface market-detail-surface"}>
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{detail?.name ?? t("market.loading")}</strong>
          <button
            type="button"
            className="config-close-button settings-dialog-close"
            onClick={() => setDetail(null)}
            aria-label={t("i18n.close")}
          >×</button>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">
            <div className="settings-general">
              {detailLoading && <p className="settings-general-description">{t("market.loading")}</p>}
              {detail && (
                <>
                  <p className="settings-general-description">{detail.description}</p>
                  <dl className="settings-definition">
                    {detail.version && (<><dt>{t("market.version")}</dt><dd><code>{detail.version}</code></dd></>)}
                    {detail.installCommand && (<><dt>{t("market.installCommand")}</dt><dd><code>{detail.installCommand}</code></dd></>)}
                    {detail.license && (<><dt>{t("market.license")}</dt><dd>{detail.license}</dd></>)}
                    {detail.size && (<><dt>{t("market.size")}</dt><dd>{detail.size}</dd></>)}
                    {detail.dependencies && (<><dt>{t("market.dependencies")}</dt><dd>{detail.dependencies}</dd></>)}
                    {detail.downloadsText && (<><dt>{t("market.downloads")}</dt><dd>{detail.downloadsText}</dd></>)}
                    {detail.publishedText && (<><dt>{t("market.published")}</dt><dd>{detail.publishedText}</dd></>)}
                    {detail.author && (<><dt>{t("market.author")}</dt><dd>{detail.author}</dd></>)}
                  </dl>
                  {detail.securityNote && <p className="settings-notice is-error">{detail.securityNote}</p>}
                  <div className="settings-table-actions">
                    <ConfigButton
                      variant="primary"
                      disabled={installBusy === detail.name || !cwd}
                      onClick={() => void install(detail.name, detail.version)}
                    >
                      {installBusy === detail.name ? t("market.installing") : t("market.install")}
                    </ConfigButton>
                    <a className="market-link" href={detail.pageUrl} target="_blank" rel="noopener noreferrer">
                      {t("market.openOnPiDev")}
                    </a>
                  </div>
                  {detail.readme && (
                    <section className="settings-general-section">
                      <h3 className="settings-general-heading">{t("market.readme")}</h3>
                      <MarkdownBody>{detail.readme}</MarkdownBody>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="settings-market">
        {body}
        {detailView}
      </div>
    );
  }

  return (
    <div className="settings-page-host">
      <div className="settings-page-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("market.title")}</strong>
          <span className="settings-general-description settings-page-link">
            <a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer">pi.dev/packages</a>
          </span>
          <Link className="settings-page-link" href="/">{t("user.back")}</Link>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">
            {body}
          </div>
        </main>
      </div>
      {detailView}
    </div>
  );
}

/** Standalone host at `/market`. */
export function MarketPage() {
  return <MarketSettings />;
}
