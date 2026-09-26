"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { safeLoginDestination } from "@/lib/login-destination";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(destination, window.location.origin);
}

function LoginForm() {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const failureMessage = async (response: Response): Promise<string> => {
    if (response.status === 401) return t("auth.invalidPassword");
    if (response.status !== 429) return t("auth.loginFailed");
    const seconds = Number(response.headers.get("retry-after"));
    return t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // One endpoint for both steps: `challenge` replaces `password` once the
        // password has been accepted.
        body: JSON.stringify(challenge ? { challenge, code } : { password }),
      });
      if (!response.ok) {
        setError(challenge ? t("auth.totpFailed") : await failureMessage(response));
        return;
      }

      const body = await response.json().catch(() => ({})) as { totpRequired?: boolean; challenge?: string };
      if (body.totpRequired && body.challenge) {
        setChallenge(body.challenge);
        setPassword("");
        setCode("");
        return;
      }
      window.location.replace(safeDestination());
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{challenge ? t("auth.totpPrompt") : t("auth.prompt")}</p>
          </div>
        </header>
        <form className="web-login-form" onSubmit={submit}>
          {challenge ? (
            <>
              <p className="web-setup-heading">{t("auth.totpTitle")}</p>
              <div className="web-login-composer">
                <label className="web-login-label" htmlFor="web-login-code">{t("auth.totpCode")}</label>
                <input
                  id="web-login-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t("auth.totpCode")}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  disabled={busy}
                />
                <button type="submit" disabled={busy || !code}>
                  {busy ? t("auth.totpVerifying") : t("auth.totpVerify")}
                </button>
              </div>
              <button
                type="button"
                className="web-login-back"
                disabled={busy}
                onClick={() => { setChallenge(""); setCode(""); setError(""); }}
              >
                {t("auth.backToPassword")}
              </button>
            </>
          ) : (
            <div className="web-login-composer">
              <label className="web-login-label" htmlFor="web-login-password">{t("auth.password")}</label>
              <input
                id="web-login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("auth.password")}
                autoComplete="current-password"
                autoFocus
                required
                disabled={busy}
              />
              <button type="submit" disabled={busy || !password}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {busy ? t("auth.loggingIn") : t("auth.logIn")}
              </button>
            </div>
          )}
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
