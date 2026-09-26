import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { getDatabase } from "@/lib/db";
import { THEME_PREVIEW_COOKIE, readActiveTheme, resolvePreviewTheme } from "@/lib/theme-store";
import { THEME_SAFETY_COOKIE } from "@/lib/theme-safety";
import { THEME_ATTRIBUTE, THEME_ATTRIBUTE_VALUE, THEME_DEFAULT_STYLE } from "@/lib/theme-source";
import { ThemeLoaderGuard } from "@/components/ThemeLoaderGuard";
import { ThemeVariantLink } from "@/components/ThemeVariantLink";
import { Noto_Sans_Mono } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  // The proxy mints one per response; `undefined` simply means the inline script
  // carries no nonce (the default report-only policy does not block it).
  const nonce = requestHeaders.get("x-nonce") ?? undefined;

  // A third-party theme is applied server-side so the first paint already has the
  // right variables. The safety cookie lets a broken theme be switched off from
  // outside the app (see components/ThemeLoaderGuard.tsx), and `/login` plus
  // `/init` are never themed at all.
  const themeAllowed = requestHeaders.get("x-pi-theme") !== "off";
  const cookieStore = await cookies();
  const themeDisabled = !themeAllowed || cookieStore.get(THEME_SAFETY_COOKIE)?.value === "1";
  // A preview cookie wins over the applied theme for this browser only, and is
  // resolved through exactly the same validation as an applied one.
  const previewSource = cookieStore.get(THEME_PREVIEW_COOKIE)?.value;
  const previewTheme = themeDisabled || !previewSource ? null : await resolvePreviewSafely(previewSource);
  const activeTheme = previewTheme ?? (themeDisabled ? null : readActiveThemeSafely());

  // A previewed theme is not the applied one, so its stylesheet has to be asked
  // for by source — otherwise the head would link to the (unset) applied theme.
  const themeHref = activeTheme
    ? (previewTheme
      ? `/api/themes/asset/${THEME_DEFAULT_STYLE}?preview=1&source=${encodeURIComponent(previewTheme.source)}`
      : `/api/themes/asset/${THEME_DEFAULT_STYLE}`)
    : null;

  return (
    <html
      lang="en"
      translate="no"
      className={`${notoSansMono.variable} notranslate`}
      data-theme={activeTheme?.manifest.base}
      {...(activeTheme ? { [THEME_ATTRIBUTE]: THEME_ATTRIBUTE_VALUE } : {})}
      {...(activeTheme && Object.keys(activeTheme.manifest.variants).length > 0 ? { "data-pi-theme-variants": "1" } : {})}
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
        {/* The guard treats these differently: a broken *preview* must never be
            able to switch themes off for this browser. */}
        {themeHref && (
          <link rel="stylesheet" href={themeHref} data-pi-theme={previewTheme ? "preview" : "active"} />
        )}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {activeTheme && <ThemeLoaderGuard />}
        {activeTheme && Object.keys(activeTheme.manifest.variants).length > 0 && (
          <ThemeVariantLink variants={activeTheme.manifest.variants} preview={previewTheme?.source ?? null} />
        )}
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}

/**
 * Reads the applied theme without ever failing the render: a missing or unwritable
 * database, a half-written setting, or an unreadable manifest all mean "no theme".
 */
function readActiveThemeSafely() {
  try {
    return readActiveTheme(getDatabase());
  } catch {
    return null;
  }
}

/** A preview source must never be able to break the render. */
async function resolvePreviewSafely(source: string) {
  try {
    return await resolvePreviewTheme(source, { db: getDatabase() });
  } catch {
    return null;
  }
}
