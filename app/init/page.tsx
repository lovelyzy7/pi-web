"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { safeLoginDestination } from "@/lib/login-destination";

interface InitStatus {
  required: boolean;
  reason: "first-run" | "configured" | "environment";
  username?: string;
  setupCodeRequired?: boolean;
  passwordPolicy?: { minLength: number; passphraseLength: number };
}

const WEAK_PASSWORD_KEYS: Record<string, string> = {
  "too-short": "init.weak.too-short",
  "too-long": "init.weak.too-long",
  "repeated": "init.weak.repeated",
  "common": "init.weak.common",
  "contains-username": "init.weak.contains-username",
  "needs-more-variety": "init.weak.needs-more-variety",
};

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(destination, window.location.origin);
}

function InitForm() {
  const { t } = useI18n();
  const [status, setStatus] = useState<InitStatus | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/web-auth/init", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((data: InitStatus) => {
        if (cancelled) return;
        setStatus(data);
        if (!data.required && data.reason === "configured") {
          window.location.replace(safeDestination());
        }
      })
      .catch(() => {
        if (!cancelled) setError(t("init.failed"));
      });
    return () => { cancelled = true; };
  }, [t]);

  const minLength = status?.passwordPolicy?.minLength ?? 10;
  const passphraseLength = status?.passwordPolicy?.passphraseLength ?? 16;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError(t("init.mismatch"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, setupCode }),
      });
      if (response.ok) {
        window.location.replace(safeDestination());
        return;
      }

      const body = await response.json().catch(() => ({})) as { error?: string; reason?: string };
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        setError(t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 }));
      } else if (body.error === "invalid_setup_code") {
        setError(t("init.invalidCode"));
      } else if (body.error === "weak_password") {
        setError(t(WEAK_PASSWORD_KEYS[body.reason ?? ""] ?? "init.weak.unknown", { min: minLength }));
      } else if (body.error === "already_configured") {
        setError(t("init.alreadyConfigured"));
      } else if (body.error === "environment_password") {
        setError(t("init.environmentManaged"));
      } else {
        setError(t("init.failed"));
      }
    } catch {
      setError(t("init.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (status && !status.required) {
    return (
      <main className="web-login-page">
        <div className="web-login-shell">
          <header className="web-login-brand">
            <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
            <div>
              <h1>Pi Web</h1>
              <p>{status.reason === "environment" ? t("init.environmentManaged") : t("init.alreadyConfigured")}</p>
            </div>
          </header>
          <form className="web-login-form">
            <div className="web-login-composer">
              <button type="submit" formAction="/login">{t("auth.logIn")}</button>
            </div>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{t("init.brandSubtitle")}</p>
          </div>
        </header>
        <h2 className="web-setup-heading">{t("init.heading")}</h2>
        <p className="web-setup-description">{t("init.description")}</p>
        <form className="web-login-form" onSubmit={submit}>
          {status?.setupCodeRequired !== false && (
            <div className="web-login-composer web-setup-field">
              <label className="web-login-label" htmlFor="init-setup-code">{t("init.setupCode")}</label>
              <input
                id="init-setup-code"
                value={setupCode}
                onChange={(event) => setSetupCode(event.target.value)}
                placeholder={t("init.setupCode")}
                autoComplete="one-time-code"
                spellCheck={false}
                autoFocus
                disabled={busy}
              />
            </div>
          )}
          <div className="web-login-composer web-setup-field">
            <label className="web-login-label" htmlFor="init-password">{t("init.password")}</label>
            <input
              id="init-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("init.password")}
              autoComplete="new-password"
              required
              minLength={minLength}
              disabled={busy}
            />
          </div>
          <div className="web-login-composer web-setup-field">
            <label className="web-login-label" htmlFor="init-password-confirm">{t("init.passwordConfirm")}</label>
            <input
              id="init-password-confirm"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={t("init.passwordConfirm")}
              autoComplete="new-password"
              required
              disabled={busy}
            />
          </div>
          <p className="web-setup-hint">
            {t("init.passwordHint", { min: minLength, passphrase: passphraseLength })}
          </p>
          {status?.setupCodeRequired !== false && (
            <p className="web-setup-hint">{t("init.setupCodeHint")}</p>
          )}
          <div className="web-setup-actions">
            <button type="submit" disabled={busy || password.length === 0}>
              {busy ? t("init.submitting") : t("init.submit")}
            </button>
          </div>
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
        </form>
      </div>
    </main>
  );
}

export default function InitPage() {
  return <I18nProvider><InitForm /></I18nProvider>;
}
