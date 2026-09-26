"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { THEME_OPTIONS } from "@/lib/theme";
import { useTheme } from "@/hooks/useTheme";
import { THEME_SAFETY_COOKIE } from "@/lib/theme-safety";
import { ThemeIcon } from "./ThemeIcon";
import { ConfigButton } from "./SettingsUi";

/**
 * Theme selection: the built-in palettes plus third-party themes.
 *
 * Third-party themes are CSS-only and served through this server
 * (`/api/themes/asset`), so the CSP keeps `style-src 'self'` and the browser
 * never talks to the theme's host. Applying one writes a server setting and
 * reloads, because the stylesheet is injected during the server render.
 */

interface ThemeManifestView {
  id: string;
  name: string;
  version: string;
  author: string;
  base: "light" | "dark";
  variants: Record<string, string>;
  homepage: string | null;
  description: Record<string, string>;
}

interface ThemeIssue {
  level: "error" | "warning";
  message: string;
}

interface StoreTheme {
  id: string;
  title: string;
  author: string;
  tags: string[];
  description: Record<string, string>;
  version: string | null;
  source: string;
  coverUrl: string | null;
  /** The entry's page, offered as a link on the card. */
  homepageUrl: string | null;
}

interface ActiveThemeView {
  source: string;
  display: string;
  ref: string;
  appliedAt: number;
  manifest: ThemeManifestView;
  cssUrl: string;
}

interface LocalThemeView {
  source: string;
  directory: string;
  origin: "managed" | "configured" | "project";
  name: string;
  id: string;
  version: string;
  author: string;
  base: "light" | "dark";
  /** Per-locale description from the manifest, for the card body. */
  description: Record<string, string>;
  homepage: string | null;
  variants: string[];
  managed: boolean;
}

interface LocalThemeScanView {
  roots: { directory: string; origin: LocalThemeView["origin"]; exists: boolean }[];
  themes: LocalThemeView[];
  importDir: string;
}

/**
 * A stand-in cover for a theme that has no image.
 *
 * Local themes carry no cover file, and a store entry may lack one. Filling the
 * same 16:9 box keeps every card in a row the same height — a missing image must
 * not shift the grid.
 */
function ThemeCardCover({ name, base }: { name: string; base: "light" | "dark" }) {
  return (
    <div className={`theme-cover-fallback theme-cover-fallback-${base}`} aria-hidden="true">
      <span className="theme-cover-glyph">{name.trim().slice(0, 1).toUpperCase()}</span>
      <span className="theme-cover-name">{name}</span>
    </div>
  );
}

/**
 * A store cover, falling back to the stand-in when the image cannot load.
 *
 * Covers are proxied, so they can fail for reasons that have nothing to do with
 * the theme (an unreachable host, a deleted file). The card keeps its geometry
 * either way — a broken image would otherwise collapse the row it sits in.
 */
function ThemeCover({ src, name, base }: { src: string; name: string; base: "light" | "dark" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ThemeCardCover name={name} base={base} />;
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className="theme-cover"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Translation key for the directory a theme was found in. */
function localOriginKey(origin: LocalThemeView["origin"]): string {
  if (origin === "managed") return "theme.localManaged";
  if (origin === "configured") return "theme.localConfigured";
  return "theme.localProject";
}

export function ThemeSettings({ cwd = null }: { cwd?: string | null }) {
  const { t, locale } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const [active, setActive] = useState<ActiveThemeView | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<{
    ok: boolean;
    manifest?: ThemeManifestView;
    issues: ThemeIssue[];
    variables: string[];
    cssUrl?: string;
    message?: string;
  } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /** Document state captured when a preview starts, restored when it stops. */
  const previewState = useRef<{ piTheme: string | null; theme: string | null } | null>(null);
  const [store, setStore] = useState<{
    configured: boolean;
    url: string | null;
    themes: StoreTheme[];
    stale: boolean;
    error?: string;
    envDefault: boolean;
  } | null>(null);
  const [storeUrl, setStoreUrl] = useState("");
  /** Versions read from each entry's own manifest, and which ones are behind. */
  const [versions, setVersions] = useState<{ map: Record<string, string | null>; newer: string[] } | null>(null);
  /** Set when the server refused a local path; the UI can then approve it. */
  const [blockedPath, setBlockedPath] = useState<string | null>(null);
  /** Themes found in the managed, configured and project directories. */
  const [local, setLocal] = useState<LocalThemeScanView | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [localNotice, setLocalNotice] = useState<{ ok: boolean; message: string } | null>(null);
  /** Source the server reported as already imported, so the button can replace it. */
  const [overwriteSource, setOverwriteSource] = useState<string | null>(null);
  /** True while themes are switched off for this browser (the safety cookie). */
  const [themesOff, setThemesOff] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/themes", { headers: { Accept: "application/json" } });
      const body = await response.json() as { active?: ActiveThemeView | null };
      setActive(body.active ?? null);
    } catch {
      setActive(null);
    }
  }, []);

  const loadStore = useCallback(async (refresh = false) => {
    try {
      const response = await fetch(`/api/themes/store${refresh ? "?refresh=1" : ""}`, {
        headers: { Accept: "application/json" },
      });
      const body = await response.json() as {
        configured: boolean; url: string | null; themes: StoreTheme[]; stale: boolean; error?: string; envDefault: boolean;
      };
      setStore(body);
      if (body.url) setStoreUrl(body.url);
      if (body.configured && body.themes.length > 0) {
        // Versions arrive separately: each one costs a manifest fetch, and the
        // list should not wait for them.
        try {
          const versionResponse = await fetch(`/api/themes/store/versions${refresh ? "?refresh=1" : ""}`, {
            headers: { Accept: "application/json" },
          });
          const payload = await versionResponse.json() as { versions?: Record<string, string | null>; newer?: string[] };
          if (versionResponse.ok) setVersions({ map: payload.versions ?? {}, newer: payload.newer ?? [] });
        } catch {
          setVersions(null);
        }
      } else {
        setVersions(null);
      }
    } catch {
      setStore(null);
    }
  }, []);

  /**
   * Finds the themes this server can already see.
   *
   * The selected project is passed along so a project's own `themes/` folder is
   * scanned too; the list itself is what saves typing `local:/abs/path` by hand.
   */
  // The safety cookie is not httpOnly: the panel has to be able to say that
  // themes are off, and to clear it.
  useEffect(() => {
    setThemesOff(document.cookie.split("; ").some((entry) => entry === `${THEME_SAFETY_COOKIE}=1`));
  }, []);

  const loadLocal = useCallback(async () => {
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const response = await fetch(`/api/themes/local${query}`, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        setLocal(null);
        return;
      }
      setLocal(await response.json() as LocalThemeScanView);
    } catch {
      setLocal(null);
    }
  }, [cwd]);

  useEffect(() => { void load(); void loadStore(); void loadLocal(); }, [load, loadStore, loadLocal]);

  /**
   * Ends the in-page preview.
   *
   * It restores what was there before rather than deleting the theme marker:
   * this runs from an unmount cleanup too, and an unconditional delete tore the
   * *applied* theme off the document whenever the panel was closed.
   */
  const stopPreview = useCallback(() => {
    document.querySelectorAll("link[data-pi-theme-preview]").forEach((node) => node.remove());
    const previous = previewState.current;
    if (previous) {
      if (previous.piTheme) document.documentElement.dataset.piTheme = previous.piTheme;
      else delete document.documentElement.dataset.piTheme;
      if (previous.theme) document.documentElement.dataset.theme = previous.theme;
      previewState.current = null;
    }
    setPreviewing(false);
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const post = async (body: Record<string, unknown>, path = "/api/themes") => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json().catch(() => ({})) as Record<string, never> };
  };

  /** Copies a local theme into the data directory so it stops depending on its original path. */
  const importTheme = async (target: string, overwrite = false) => {
    const requested = target.trim();
    if (!requested || busy !== null) return;
    setBusy("import");
    setLocalNotice(null);
    setOverwriteSource(null);
    try {
      const { response, body } = await post({ action: "import", source: requested, overwrite }, "/api/themes/local");
      const payload = body as unknown as { ok?: boolean; directory?: string; error?: string; message?: string };
      if (!response.ok || !payload.ok) {
        // The only error the operator can act on here is a name that is
        // already taken; everything else is reported as-is.
        if (payload.error === "exists") setOverwriteSource(requested);
        setLocalNotice({ ok: false, message: payload.message ?? `HTTP ${response.status}` });
        return;
      }
      setLocalNotice({ ok: true, message: t("theme.localImported", { path: payload.directory ?? "" }) });
      setLocalPath("");
      await loadLocal();
    } catch (cause) {
      setLocalNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };

  const removeTheme = async (entry: LocalThemeView) => {
    if (busy !== null) return;
    if (!window.confirm(t("theme.localRemoveConfirm", { name: entry.name, path: entry.directory }))) return;
    setBusy("remove");
    setLocalNotice(null);
    try {
      const { response, body } = await post({ action: "remove", source: entry.source }, "/api/themes/local");
      const payload = body as unknown as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        setLocalNotice({ ok: false, message: payload.message ?? `HTTP ${response.status}` });
        return;
      }
      setLocalNotice({ ok: true, message: t("theme.localRemoved", { name: entry.name }) });
      await loadLocal();
    } catch (cause) {
      setLocalNotice({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };

  const check = async (apply: boolean, explicitSource?: string, allowLocal = false) => {
    const requested = (explicitSource ?? source).trim();
    if (!requested) return;
    stopPreview();
    setBusy(apply ? "apply" : "check");
    setNotice(null);
    try {
      const { response, body } = await post({ source: requested, preview: !apply, allowLocal });
      const payload = body as unknown as {
        manifest?: ThemeManifestView;
        issues?: ThemeIssue[];
        overriddenVariables?: string[];
        cssUrl?: string;
        message?: string;
      };
      if (!response.ok) {
        const error = (body as { error?: string }).error;
        setBlockedPath(error === "blocked_path" ? requested.replace(/^local:/, "") : null);
        setReport({ ok: false, issues: payload.issues ?? [], variables: [], message: payload.message ?? `HTTP ${response.status}` });
        return;
      }
      setBlockedPath(null);
      setReport({
        ok: true,
        manifest: payload.manifest,
        issues: payload.issues ?? [],
        variables: payload.overriddenVariables ?? [],
        cssUrl: payload.cssUrl,
      });
      if (apply) {
        setNotice({ ok: true, message: t("theme.applied") });
        window.location.reload();
      }
    } catch (cause) {
      setReport({ ok: false, issues: [], variables: [], message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };

  const preview = () => {
    if (!report?.cssUrl) return;
    stopPreview();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = report.cssUrl;
    link.dataset.piThemePreview = "true";
    document.head.appendChild(link);
    // Preview mirrors what the server render would do: base palette plus the
    // theme marker, with the stylesheet loaded from the same-origin proxy.
    previewState.current = {
      piTheme: document.documentElement.dataset.piTheme ?? null,
      theme: document.documentElement.dataset.theme ?? null,
    };
    document.documentElement.dataset.theme = report.manifest?.base ?? "dark";
    document.documentElement.dataset.piTheme = "custom";
    setPreviewing(true);
  };

  const restore = async () => {
    stopPreview();
    setBusy("restore");
    try {
      await fetch("/api/themes", { method: "DELETE" });
      setNotice({ ok: true, message: t("theme.restored") });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  };

  const saveStoreUrl = async () => {
    setBusy("store");
    try {
      const response = await fetch("/api/themes/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: storeUrl }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        setNotice({ ok: false, message: body.message ?? `HTTP ${response.status}` });
        return;
      }
      await loadStore();
    } finally {
      setBusy(null);
    }
  };

  const previewInApp = (source: string) => {
    window.open(`/api/themes/preview?source=${encodeURIComponent(source)}`, "_blank", "noopener");
  };

  const disableThemesOnDevice = () => {
    try {
      document.cookie = `${THEME_SAFETY_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax`;
    } catch {
      // ignore
    }
    setThemesOff(true);
    window.location.reload();
  };

  /**
   * The way back from the escape hatch.
   *
   * `THEME_SAFETY_COOKIE` is set by the loader guard when the applied stylesheet
   * fails to load and by the button above. Without a control that clears it, a
   * single failure made every theme — and every preview — invisible for a day,
   * with nothing in the interface saying why.
   */
  const enableThemesOnDevice = () => {
    try {
      document.cookie = `${THEME_SAFETY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    } catch {
      // ignore
    }
    setThemesOff(false);
    window.location.reload();
  };

  const description = report?.manifest
    ? report.manifest.description[locale] ?? report.manifest.description.en ?? ""
    : "";

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.theme")}</h2>
      <p className="settings-general-description">{t("settings.themeDescription")}</p>

      {themesOff && (
        <div className="settings-notice is-error" role="status" aria-live="polite">
          <p>{t("theme.disabledOnDevice")}</p>
          <ConfigButton variant="secondary" size="small" onClick={enableThemesOnDevice}>
            {t("theme.enableOnDevice")}
          </ConfigButton>
        </div>
      )}

      {/*
        The layout follows CF-Server-Monitor's theme page: a warning strip, the
        current theme in a label/value bar, the source form in a card, and one
        card grid — local themes and store entries together, with the actions
        pinned to the bottom of every card so a row of them lines up.
      */}
      <div className="theme-page">
        <div className="theme-warning">
          <div className="theme-warning-head">
            <span className="theme-warning-icon" aria-hidden="true">⚠️</span>
            <span className="theme-warning-title">{t("theme.warningTitle")}</span>
          </div>
          <p className="theme-warning-desc">{t("theme.warningDesc")}</p>
          <p className="theme-warning-desc">{t("theme.descriptionHint")}</p>
          <p className="theme-warning-desc">{t("theme.safety")}</p>
          <div className="theme-warning-actions">
            <ConfigButton variant="ghost" size="small" onClick={disableThemesOnDevice}>
              {t("theme.safetyAction")}
            </ConfigButton>
            {themesOff && (
              <ConfigButton variant="secondary" size="small" onClick={enableThemesOnDevice}>
                {t("theme.enableOnDevice")}
              </ConfigButton>
            )}
          </div>
          {themesOff && <p className="theme-warning-note">{t("theme.disabledOnDevice")}</p>}
        </div>

        <div className="theme-toolbar">
          <div className="theme-current">
            <span className="theme-current-label">{t("theme.current")}</span>
            <span className="theme-current-value">
              {active ? active.manifest.name : t("theme.none")}
            </span>
            {active && (
              <span className="theme-current-meta">
                <span className="theme-version">v{active.manifest.version}</span>
                <span className="theme-tag">{active.manifest.base === "dark" ? t("theme.baseDark") : t("theme.baseLight")}</span>
                {Object.keys(active.manifest.variants ?? {}).length > 0 && (
                  <span className="theme-tag">{t("theme.variantsCount", { count: Object.keys(active.manifest.variants).length })}</span>
                )}
                <code className="theme-current-source">{active.display}</code>
                <code className="theme-version">{active.ref}</code>
              </span>
            )}
          </div>
        </div>

        <div className="theme-custom">
          <div className="theme-custom-header">
            <div>
              <div className="theme-custom-title">{t("settings.appearance")}</div>
              <div className="theme-custom-desc">{t("theme.appearanceHint")}</div>
            </div>
          </div>
          <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
            {THEME_OPTIONS.map((option) => {
              const selected = preference === option.id;
              return (
                <label key={option.id} className="settings-theme-option">
                  <input
                    type="radio"
                    name="theme"
                    value={option.id}
                    checked={selected}
                    onChange={() => setThemePreference(option.id)}
                    className="sr-only"
                  />
                  <ThemeIcon preference={option.id} />
                  <span className="settings-theme-option-label">{t(option.label)}</span>
                </label>
              );
            })}
          </div>
          {active && <p className="theme-custom-desc">{t("theme.overriddenByTheme")}</p>}
          {active && Object.keys(active.manifest.variants ?? {}).length > 0 && (
            <p className="theme-custom-desc">{t("theme.variantsHint")}</p>
          )}
        </div>

        <div className="theme-custom">
          <div className="theme-custom-header">
            <div>
              <div className="theme-custom-title">{t("theme.customSourceTitle")}</div>
              <div className="theme-custom-desc">{t("theme.sourceHint")}</div>
            </div>
          </div>
          <div className="theme-custom-form">
            <input
              className="theme-input"
              value={source}
              placeholder={t("theme.sourcePlaceholder")}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              aria-label={t("theme.sourceLabel")}
            />
            <ConfigButton variant="secondary" size="small" disabled={busy !== null || !source.trim()} onClick={() => void check(false)}>
              {busy === "check" ? t("theme.checking") : t("theme.check")}
            </ConfigButton>
            <ConfigButton variant="primary" size="small" disabled={busy !== null || !source.trim()} onClick={() => void check(true)}>
              {busy === "apply" ? t("theme.applying") : t("theme.apply")}
            </ConfigButton>
            {previewing
              ? <ConfigButton variant="secondary" size="small" onClick={stopPreview}>{t("theme.previewEnd")}</ConfigButton>
              : <ConfigButton variant="secondary" size="small" disabled={!report?.ok} onClick={preview}>{t("theme.preview")}</ConfigButton>}
            <ConfigButton
              variant="secondary"
              size="small"
              disabled={!report?.ok}
              onClick={() => report?.manifest && previewInApp(source.trim())}
            >
              {t("theme.previewInApp")}
            </ConfigButton>
            {active && (
              <ConfigButton variant="danger" size="small" disabled={busy !== null} onClick={() => void restore()}>
                {t("theme.restore")}
              </ConfigButton>
            )}
          </div>

          {notice && (
            <p className={`settings-notice ${notice.ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
              {notice.message}
            </p>
          )}
          {previewing && <p className="settings-notice is-ok">{t("theme.previewing")}</p>}

          {report && (
            <div className="theme-report">
              <div className="theme-report-head">
                <span className="theme-custom-title">{t("theme.reportHeading")}</span>
                {report.manifest && <span className="theme-version">v{report.manifest.version}</span>}
              </div>
              <p className="theme-custom-desc">
                {report.ok
                  ? t("theme.variables", { count: report.variables.length })
                  : t("theme.readFailed", { message: report.message ?? "" })}
              </p>
              {description && <p className="theme-custom-desc">{description}</p>}
              {blockedPath && (
                <div className="theme-actions">
                  <ConfigButton variant="secondary" size="small" onClick={() => void check(true, source.trim(), true)}>
                    {t("theme.allowDirectory", { path: blockedPath })}
                  </ConfigButton>
                </div>
              )}
              {report.issues.length === 0
                ? report.ok && <p className="settings-notice is-ok">{t("theme.noIssues")}</p>
                : (
                  <ul className="settings-theme-issues">
                    {report.issues.map((issue, index) => (
                      <li key={index} className={issue.level === "error" ? "is-error" : "is-warning"}>{issue.message}</li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </div>

        {/* Discovery roots stay behind a disclosure: reference, not a decision. */}
        <details className="theme-roots">
          <summary>{t("theme.probeRoots", { count: local?.roots.length ?? 0 })}</summary>
          {local && local.roots.length > 0 ? (
            <ul className="theme-roots-list">
              {local.roots.map((root) => (
                <li key={root.directory} className={root.exists ? undefined : "is-missing"}>
                  <code>{root.directory}</code>
                  <span className="theme-tag">{t(localOriginKey(root.origin))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="theme-custom-desc">{t("theme.localEmpty")}</p>
          )}
        </details>

        <div className="theme-grid">
          {(local?.themes ?? []).map((entry) => (
            <article key={entry.source} className={`theme-card${active?.source === entry.source ? " is-active" : ""}`}>
              <div className="theme-cover-wrap">
                <ThemeCardCover name={entry.name} base={entry.base} />
              </div>
              <div className="theme-info">
                <div className="theme-header">
                  <h3 className="theme-title">{entry.name}</h3>
                  <span className="theme-version">v{entry.version}</span>
                </div>
                <div className="theme-tags">
                  <span className="theme-tag">{t(localOriginKey(entry.origin))}</span>
                  <span className="theme-tag">{entry.base === "dark" ? t("theme.baseDark") : t("theme.baseLight")}</span>
                  {entry.variants.length > 0 && (
                    <span className="theme-tag">{t("theme.variantsCount", { count: entry.variants.length })}</span>
                  )}
                </div>
                <p className="theme-desc">
                  {entry.description[locale] ?? entry.description.en ?? t("theme.noDescription")}
                </p>
                <div className="theme-author">by {entry.author}</div>
                <code className="theme-path">{entry.directory}</code>
                <div className="theme-space" />
                <div className="theme-actions">
                  <ConfigButton
                    variant={active?.source === entry.source ? "secondary" : "primary"}
                    size="small"
                    disabled={busy !== null || active?.source === entry.source}
                    onClick={() => void check(true, entry.source)}
                  >
                    {active?.source === entry.source ? t("theme.storeApplied") : t("theme.apply")}
                  </ConfigButton>
                  <ConfigButton variant="secondary" size="small" onClick={() => previewInApp(entry.source)}>
                    {t("theme.previewInAppShort")}
                  </ConfigButton>
                  {entry.managed
                    ? (
                      <ConfigButton variant="danger" size="small" disabled={busy !== null} onClick={() => void removeTheme(entry)}>
                        {t("theme.localRemove")}
                      </ConfigButton>
                    )
                    : (
                      <ConfigButton variant="secondary" size="small" disabled={busy !== null} onClick={() => void importTheme(entry.source)}>
                        {busy === "import" ? t("theme.localImporting") : t("theme.localImport")}
                      </ConfigButton>
                    )}
                </div>
              </div>
            </article>
          ))}

          {(store?.themes ?? []).map((entry) => (
            <article key={`${entry.id}:${entry.source}`} className={`theme-card${active?.source === entry.source ? " is-active" : ""}`}>
              <div className="theme-cover-wrap">
                {entry.coverUrl
                  /* Cover images are proxied, so browsing the store never
                     reaches GitHub from the browser. */
                  ? <ThemeCover src={`/api/themes/cover?url=${encodeURIComponent(entry.coverUrl)}`} name={entry.title} base="dark" />
                  : <ThemeCardCover name={entry.title} base="dark" />}
              </div>
              <div className="theme-info">
                <div className="theme-header">
                  <h3 className="theme-title">{entry.title}</h3>
                  {(versions?.map[entry.source] || entry.version) && (
                    <span className="theme-version">v{versions?.map[entry.source] ?? entry.version}</span>
                  )}
                </div>
                {entry.tags.length > 0 && (
                  <div className="theme-tags">
                    {entry.tags.map((tag) => <span key={tag} className="theme-tag">{tag}</span>)}
                  </div>
                )}
                <p className="theme-desc">{entry.description[locale] ?? entry.description.en ?? ""}</p>
                <div className="theme-author">by {entry.author}</div>
                {versions?.newer.includes(entry.source) && (
                  <p className="theme-update-hint">{t("theme.storeUpdateAvailable")}</p>
                )}
                <div className="theme-space" />
                <div className="theme-actions">
                  <ConfigButton
                    variant={versions?.newer.includes(entry.source) ? "danger" : "primary"}
                    size="small"
                    disabled={busy !== null || (active?.source === entry.source && !versions?.newer.includes(entry.source))}
                    onClick={() => void check(true, entry.source)}
                  >
                    {active?.source === entry.source
                      ? (versions?.newer.includes(entry.source) ? t("theme.storeUpdate") : t("theme.storeApplied"))
                      : t("theme.apply")}
                  </ConfigButton>
                  <ConfigButton variant="secondary" size="small" onClick={() => previewInApp(entry.source)}>
                    {t("theme.previewInAppShort")}
                  </ConfigButton>
                  {entry.homepageUrl && (
                    <a
                      className="market-link theme-view-link"
                      href={entry.homepageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ↗ {t("theme.view")}
                    </a>
                  )}
                </div>
              </div>
            </article>
          ))}

          {local && local.themes.length === 0 && (store?.themes.length ?? 0) === 0 && (
            <p className="theme-custom-desc">
              {store && !store.configured ? t("theme.storeNotConfigured") : t("theme.localEmpty")}
            </p>
          )}
        </div>

        {/* Manual import shares one row with the re-scan. */}
        <div className="theme-import-row">
          <input
            className="theme-input"
            value={localPath}
            placeholder={t("theme.localImportPlaceholder")}
            onChange={(event) => setLocalPath(event.target.value)}
            spellCheck={false}
            aria-label={t("theme.localImportPath")}
          />
          <ConfigButton
            variant="secondary"
            size="small"
            disabled={busy !== null || !localPath.trim()}
            onClick={() => void importTheme(localPath)}
          >
            {busy === "import" ? t("theme.localImporting") : t("theme.localImport")}
          </ConfigButton>
          <ConfigButton variant="ghost" size="small" disabled={busy !== null} onClick={() => void loadLocal()}>
            {t("theme.localScan")}
          </ConfigButton>
        </div>
        {local && (
          <p className="theme-custom-desc">{t("theme.localImportDir", { path: local.importDir })}</p>
        )}
        {localNotice && (
          <p className={`settings-notice ${localNotice.ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
            {localNotice.message}
          </p>
        )}
        {overwriteSource && (
          <div className="theme-actions">
            <ConfigButton variant="danger" size="small" disabled={busy !== null} onClick={() => void importTheme(overwriteSource, true)}>
              {t("theme.localOverwrite")}
            </ConfigButton>
          </div>
        )}

        {/* The store address is configured here, next to the grid it fills. */}
        <div className="theme-footer">
          <div className="theme-footer-text">
            <span className="theme-custom-title">{t("theme.storeHeading")}</span>
            <span className="theme-custom-desc">
              {store?.configured
                ? `${t("theme.storeSource", { url: store.url ?? "" })}${store.envDefault ? ` · ${t("theme.storeFromEnv")}` : ""}${store.stale ? ` · ${t("theme.storeStale")}` : ""}`
                : t("theme.storeNotConfigured")}
            </span>
            {store?.error && <span className="theme-custom-desc theme-error-text">{store.error}</span>}
          </div>
          <div className="theme-actions">
            {store?.configured
              ? (
                <ConfigButton variant="secondary" size="small" disabled={busy !== null} onClick={() => void loadStore(true)}>
                  {t("theme.storeRefresh")}
                </ConfigButton>
              )
              : (
                <>
                  <input
                    className="theme-input theme-input-inline"
                    value={storeUrl}
                    placeholder="https://raw.githubusercontent.com/you/pi-web-theme-store/main/themes.json"
                    onChange={(event) => setStoreUrl(event.target.value)}
                    spellCheck={false}
                    aria-label={t("theme.storeUrl")}
                  />
                  <ConfigButton variant="secondary" size="small" disabled={busy !== null || !storeUrl.trim()} onClick={() => void saveStoreUrl()}>
                    {t("theme.storeSave")}
                  </ConfigButton>
                </>
              )}
            <a className="market-link" href="https://github.com/lovelyzy7/pi-web/blob/main/docs/theme-development.md" target="_blank" rel="noopener noreferrer">
              {t("theme.docs")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
