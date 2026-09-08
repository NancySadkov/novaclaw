# @novaclaw/app

The NovaClaw HTML UI — the whole product surface, rendered identically by the Electron desktop app
and in a browser. Solid + Vite. It is a thin client: it reaches an instance by URL and credentials
and never assumes it shares a process or a machine with the runtime.

## Run it

```bash
bun install                 # from the repo root
bun --cwd packages/app run dev        # Vite alone, on :3000 — bring your own backend
bun --cwd packages/app run dev:full   # Vite + a backend on :4096
```

⚠️ `dev:full` starts a backend **on the default home** and tree-kills it on exit, including one you
started yourself. When the store matters — a seeded fixture, an isolated home, fault injection — run
`dev` and start the backend yourself with `NOVACLAW_HOME` (and `NOVACLAW_DB` when needed)
set. `bun run build` emits the static `dist/` the desktop packager embeds.

## Tests

`bun run test` covers the unit suites (`src`, happy-dom) and the browser suites (`test-browser`).
`bun run typecheck` runs tsgo.

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests expect a NovaClaw
backend at `localhost:4096` by default.

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)
