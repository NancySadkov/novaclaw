# NovaClaw

**A local-first AI agent OS — your models, your machine, your data.**

NovaClaw runs AI agent sessions against **local models** (for example a vLLM server on your own
hardware) or any OpenAI-compatible endpoint — no paid APIs required, and your chats, code, and
knowledge base never leave your machine. It ships a friendly desktop app (Electron) with the same
HTML UI available in the browser, plus a headless server for remote or LAN instances.

The organizing idea: an **operating system whose processes are agent sessions**. Sessions spawn
sub-sessions, exit with results a parent can join, inherit configuration down the parent chain, and
show up in a task manager like any other process. Home is an app launcher — Chats, Processes,
Settings, Notes, Files, Search — not a terminal.

## Download

**You do not need to build anything.** This repository is the source; if you just want to *run*
NovaClaw, download a prebuilt release:

| Where | What you get |
|---|---|
| **[nancygold.itch.io/novaclaw](https://nancygold.itch.io/novaclaw)** | The prebuilt releases — pay-what-you-want, free to download |
| **[novaclaw.app](https://novaclaw.app)** | The same builds, with a published SHA-256 for each file |

Windows builds are **portable**: unpack the zip wherever you like and run `NovaClaw.exe`. There is
no installer, no admin rights, and no setup step — the server it needs is bundled inside. Point it
at your model in **Settings** and you're running.

Both pages always list the current release, so this file never goes stale about it. macOS and Linux
packaging targets exist in the build config but are not released yet; on those platforms, build from
source as described below.

## Highlights

- **Private / local-LLM first.** The data plane (chats, code, knowledge) never egresses; fully
  airgappable. Any OpenAI-compatible `/v1` endpoint works — vLLM, llama.cpp, LM Studio, Ollama, or a
  hosted key if you bring one.
- **Built for small models.** A deterministic harness wraps the model: task decomposition, per-step
  verification, and tolerance for imperfect tool calls — so local open-weight models finish jobs
  that usually get thrown at frontier APIs.
- **Easy to deploy.** Unpack the desktop app anywhere and run it; the server sidecar is bundled.
  Headless instances are one command and can be driven from another machine's UI (every instance is
  a node — URL + token).
- **Self-healing by design.** A crashed server auto-restarts and the UI reconnects; operational
  settings live in runtime-editable stores, so a working agent can repair its own instance.
- **No bloat.** No ads, no telemetry of your content, no bundled cloud upsells.

## Requirements

- [Bun](https://bun.sh) 1.3.14
- Node.js 24+
- Windows, macOS, or Linux for development. **Windows x64 is the currently shipped desktop build**;
  macOS/Linux packaging targets exist in the build config but are not yet released.

## Build

```sh
bun install
```

Desktop app (development):

```sh
bun run dev:desktop
```

Web UI (development, in a browser):

```sh
bun run dev:web
```

Headless server / CLI:

```sh
bun run --cwd packages/novaclaw --conditions=browser src/index.ts serve
```

Packaged portable Windows build (what ships on [novaclaw.app](https://novaclaw.app)):

```sh
cd packages/desktop
# PowerShell: $env:NOVACLAW_CHANNEL = "prod"
NOVACLAW_CHANNEL=prod bun run prebuild
NOVACLAW_CHANNEL=prod bun run build
NOVACLAW_CHANNEL=prod bunx electron-builder --win dir --config electron-builder.config.ts --publish never
```

The app lands in `packages/desktop/dist/win-unpacked/` — copy that folder anywhere and run
`NovaClaw.exe`.

Tests:

```sh
bun run test
```

## Configuration

Settings (providers, models, permissions) live in the app's own store and are edited in-app under
**Settings**; a JSONC import/export (`novaclaw.jsonc`) is available for bootstrapping and backup.
Point NovaClaw at any OpenAI-compatible endpoint (`/v1/chat/completions` + `/v1/models`).

## Author

NovaClaw is designed and developed by **Nancy Sadkov**.

## Status

In active development. The current release version is shown on the [download pages](#download) and in
the app under **Settings → About** — deliberately not repeated here, so it cannot go stale.

## License

NovaClaw is © Nancy Sadkov and licensed under the **Functional Source License 1.1 with an Apache 2.0
Future License** ([FSL-1.1-ALv2](LICENSE)).

- **Free for you to use, read, modify, and redistribute** — including commercially, inside a
  business, for research, or for teaching.
- **The one restriction is competing use:** you may not offer NovaClaw, or a substantially similar
  product, to others as a commercial product or service that competes with ours.
- **Every release becomes Apache 2.0 two years after it ships.** That grant is irrevocable and is
  made in advance, in the license itself.

Three things the license makes explicit, because they matter for an agent OS: **third-party apps and
plugins are separate works** you may license and sell however you like; **your recipes, prompts,
skills, and configuration are your own**; and **anything NovaClaw produces when you run it is
yours**.

Need something the license doesn't cover? A commercial license is available — just ask.

**The name is not licensed with the code.** You may fork NovaClaw; you may not call your fork
NovaClaw. See [`TRADEMARK.md`](TRADEMARK.md), which is short and permissive about everything except
naming.

## Contributing

Patches are welcome — read [`CONTRIBUTING.md`](CONTRIBUTING.md) first, and ask before building
anything large. Contributions require a one-time signed [`CLA`](CLA.md) so that NovaClaw's
relicensing promises above stay possible.
