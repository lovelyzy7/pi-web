# Pi Web

[中文](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

**[Try the interactive demo →](https://agegr.github.io/pi-web/)** The real Pi Web UI runs entirely in your browser, with sample sessions, files and models. There is nothing to install; replies are pre-written and no model is called.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/lovelyzy7/pi-web/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **Marketplace and updates**: browse the pi.dev package catalog and install from it, and see the installed, latest, and pending versions of Pi Web, the pi SDK, and your plugins — both in the settings panel, next to Models and Plugins.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.
- **Five built-in palettes plus a system option**, chosen in the Theme section of the settings panel.
- **Third-party themes**: CSS-only theme packages loaded from a GitHub repository or a local directory and served through the app itself — with light/dark variants, a browsable theme store (versions and update hints included), and a real-interface preview. The theme section of the settings scans the data directory, `PI_WEB_THEME_ROOTS`, and the selected project's `themes/` folder, and can import what it finds into the data directory (`themes/slate/` in this repository is an example). Write one with the [theme development guide](./docs/theme-development.md) and check it with `node bin/pi-web-theme.js check ./my-theme`.

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @agegr/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

To update, stop the running process with `Ctrl+C` and run the same install command again. To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Run on an environment password instead of the built-in account; API clients may use Basic Auth with username `pi` | Account stored in the database |
| `PI_WEB_INIT_TOKEN` | Pin the first-run setup code instead of reading it from the log | Random code, printed at startup |
| `PI_WEB_CSP` | Content-Security-Policy mode: `report-only`, `enforce`, or `off` | `report-only` |
| `PI_WEB_NPM_REGISTRY` | Registry for update checks and the marketplace | `https://registry.npmjs.org` |
| `PI_WEB_MARKET_BASE_URL` | Catalog source for the marketplace | `https://pi.dev` |
| `PI_WEB_THEME_STORE_URL` | JSON manifest listing third-party themes | Unset (store off) |
| `PI_WEB_THEME_ALLOW_ANY_URL` | Accept theme sources from hosts other than GitHub | Off |
| `PI_WEB_THEME_ROOTS` | Extra directories a local theme may be read from, comma-separated | Unset |
| `PI_WEB_ALLOW_SELF_UPDATE` | Let the server install a new release into `PI_WEB_RELEASES_DIR` and restart itself | Off |
| `PI_WEB_RELEASES_DIR` | Where the in-container updater puts releases | `/opt/pi-web-releases` |
| `PI_WEB_SESSION_TTL_MS` | Idle session lifetime in milliseconds | `2592000000` (30 days) |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Account and First-Run Setup

Pi Web keeps one operator account in a SQLite database under `~/.pi/agent/pi-web/`. The first visit to an installation without an account lands on **/init**, which asks for a setup code printed in the server log:

```bash
pi-web --hostname 0.0.0.0          # the log prints: First-run setup code: XXXX-XXXX
# or pin it yourself, which also makes scripted setup possible:
PI_WEB_INIT_TOKEN='my-setup-code' pi-web --hostname 0.0.0.0
```

After that, `/login` signs you in. The **Account** section of the settings panel (and the deep link `/user`) is the account centre: change the password, enroll **two-factor authentication** (TOTP, with single-use recovery codes), create **API tokens**, see and revoke signed-in devices, and read the setup/sign-in audit log. Sessions are random tokens stored as digests, so signing one device out does not disturb the others, and the account data survives restarts inside `~/.pi/agent`.

Two things behave differently once a second factor is enrolled:

- sign-in asks for the password and then the code (or a recovery code);
- **HTTP Basic is refused**, because it cannot carry a code. Use an API token instead:

```bash
curl -H "Authorization: Bearer pi_pat_…" https://pi.example.com/api/sessions
```

Security headers (including a Content-Security-Policy that defaults to report-only) are documented in [docs/docker.md](./docs/docker.md).

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. Always set a long password, and keep the setup code private until `/init` is complete:

```bash
pi-web --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### Docker

Two Dockerfiles: `Dockerfile` (Chinese mirrors, the default) and `Dockerfile.global` (upstream sources everywhere); they are identical apart from the mirror defaults, and the build detects the VPS architecture (amd64 / arm64 / armhf) on its own. Full Ubuntu image, volume rules, and 1Panel reverse-proxy notes: [docs/docker.md](./docs/docker.md).

```bash
docker build -t pi-web:latest .                      # inside China
docker build -f Dockerfile.global -t pi-web:latest . # anywhere else
```

**The trap worth knowing**: project directories must be mounted at the **same absolute path**, as a **parent directory** (`-v /srv:/srv`). Session files store absolute working directories, so mounting at a different path (`-v /srv/app:/workspace/app`) is the same as not mounting it. Pi Web does not pretend otherwise: the file browser says "directory does not exist: <path>", the skills and plugins sections show the global scope only, and sending a message explains that the session directory is missing on the server. Section 4 of the guide has the three measured mount variants.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Static browser demo published to GitHub Pages (see demo/README.md)
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
