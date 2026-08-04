# Building and running NovaClaw on Linux

There is no prebuilt Linux release yet — the [download pages](README.md#download) ship Windows
portable builds. On Linux you build from source, which is a `bun install` plus one build command.

Everything in this file was run on **Ubuntu 24.04.4 LTS, aarch64, Bun 1.3.14, Node 24.18.0**. Where
something could not be verified on that machine (it is headless, so no GUI app could be launched),
it says so rather than guessing.

**The short version**, once you have Bun and Node (§1):

```bash
bun install
bun run --cwd packages/novaclaw build --single --skip-install
./packages/novaclaw/dist/novaclaw-linux-*/bin/novaclaw web --home ~/novaclaw-instance
```

That builds one executable with the whole app inside it and opens it in your browser. Everything
below is the same thing in parts, plus the desktop app.

**Or run it in one command.** [`build-linux.sh`](build-linux.sh) automates everything in this file:
it preflights the toolchain (and prints the single line that fixes a missing piece), builds the
target you pick, smokes the built binary over HTTP, and prints artifact paths, sizes and sha256.

```bash
bash build-linux.sh            # the self-contained binary (default), smoked
bash build-linux.sh --all      # binary + AppImage + .deb + .rpm
```

Targets: `--binary` (default) · `--server-only` · `--appimage` · `--deb` · `--rpm` · `--all`;
`--channel dev|beta|prod` (default `dev`); `--maintainer "Name <email>"` for `.deb`/`.rpm` (it
otherwise derives one from the desktop `package.json` author); `--baseline` for an x86-64 CPU without
AVX2; `--force` to pass the low-memory guard. It exits with a distinct code per failure class — **10**
preflight · **20** build · **30** package · **40** smoke — so a caller (human or agent) can branch
without parsing prose. The sections below are the same steps by hand, and remain the source of truth
for what the script does.

## 1. What you need

|                                     |                                                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun 1.3.14**                      | The pinned toolchain — the repo's `packageManager`. Runs everything except the Vite steps.                                                                                              |
| **Node.js 20.19+** (24 recommended) | Vite 7 runs under Node, and the web-UI and desktop builds shell out to it. Node 18 fails with `crypto.hash is not a function`. Not needed if you only build the server binary — see §4. |
| **git, curl, unzip**                | Source, and the Bun installer.                                                                                                                                                          |

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
```

If your distro's Node is older than 20.19, the official tarball is the least invasive fix:

```bash
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
```

(On ARM swap `linux-x64` for `linux-arm64`. `nvm` or NodeSource work just as well.)

**Optional, depending on what you plan to do:**

| You want to                                      | Install                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run a built `.AppImage`                          | `libfuse2t64` (Ubuntu 24.04) or `libfuse2` (older)                                                                                                                                                                                       |
| Build an `.rpm`                                  | `rpm` (provides `rpmbuild`)                                                                                                                                                                                                              |
| Let unattended agent sessions run shell commands | `bubblewrap` — see §8                                                                                                                                                                                                                    |
| Run the desktop app                              | A graphical session, plus the libraries the built `.deb` declares: `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1`, `libsecret-1-0`. Any normal desktop install already has them. |

Building a `.deb` needs no extra tools — electron-builder brings its own `fpm` — but it does need a
maintainer field (§5).

## 2. Get the source and install

```bash
git clone <the novaclaw repository> novaclaw
cd novaclaw
bun install
```

That fetches roughly 800 MB into `node_modules` and fixes the `node-pty` spawn-helper's exec bit (a
`postinstall` step that exists because npm packaging drops the mode). Electron itself is downloaded
for your architecture when you first package the desktop app (§5).

## 3. Run it from source

The fastest edit-and-see loop. Two processes: the server, and the UI.

### The server

```bash
cd packages/novaclaw
bun run --conditions=browser src/index.ts serve --port 4096
```

The supervised server inherits the resolved working directory, so launching this equivalently with
`bun run --cwd packages/novaclaw … serve` from the repository root is supported too.

Check it:

```bash
curl -s http://127.0.0.1:4096/api/health
```

`{"healthy":true}` means it is up. Opening `/` in a browser shows a small "NovaClaw API" page —
from source the web UI is not baked in, so the server has no page to serve. That is what §4 is for.

### The web UI

```bash
bun run dev:web
```

Vite serves the app on <http://localhost:3000> (it binds `0.0.0.0`, so it is reachable from the
LAN too). In dev it looks for the server on `localhost:4096` — hence the port above. Override with
`VITE_NOVACLAW_SERVER_HOST` and `VITE_NOVACLAW_SERVER_PORT`.

### The desktop app

```bash
bun run dev:desktop
```

Electron + Vite with hot reload. Needs a graphical session (X11 or Wayland) — _not verified here_,
the test machine has no display.

## 4. Build one self-contained binary

This is the best way to run NovaClaw on a Linux box: a single executable with the web UI baked
into it, so a browser on any machine gets the full app with no Vite and no Electron.

```bash
bun run --cwd packages/novaclaw build --single --skip-install
```

- `--single` builds only for the host platform (the default is all twelve targets).
- `--skip-install` skips two `bun add` calls the build otherwise makes, which rewrite
  `packages/novaclaw/package.json` and `bun.lock` as a side effect. Drop it on a first build if
  `@parcel/watcher` or `@ff-labs/fff-bun` are missing for your platform.
- Add `--baseline` on an x86-64 CPU without AVX2.
- Add `--skip-embed-web-ui` for a server-only binary — the API without the bundled UI, which you
  then reach from another NovaClaw instance or from `bun run dev:web`. That is the one build in this
  file that needs **no Node at all** (verified with Node 18 on `PATH`): the Vite step is the only
  thing that uses it.

The result is `packages/novaclaw/dist/novaclaw-linux-<arch>/bin/novaclaw` (145 MB on arm64, with
the UI embedded). Copy it anywhere. To run it:

```bash
./novaclaw web --home ~/novaclaw-instance
```

`web` starts the server and opens your browser at it. On a headless box, serve it instead and
point a browser at the machine:

```bash
NOVACLAW_SERVER_PASSWORD='choose-a-token' ./novaclaw serve \
  --hostname 0.0.0.0 --port 4096 --home ~/novaclaw-instance
```

`serve` is supervised by default: if the server crashes, the small parent process restarts it with
bounded backoff. `--no-supervise` is an explicit diagnostic escape hatch, not a normal launch requirement.

Without `NOVACLAW_SERVER_PASSWORD` the server is unauthenticated and it says so at startup — fine
on `127.0.0.1`, not fine on `0.0.0.0`.

## 5. Build the desktop app package

```bash
cd packages/desktop
NOVACLAW_CHANNEL=prod bun run prebuild
NOVACLAW_CHANNEL=prod bun run build
NOVACLAW_CHANNEL=prod bunx electron-builder --linux AppImage --config electron-builder.config.ts --publish never
```

`prebuild` copies the channel's icons and AppStream metainfo and bundles the Node server sidecar;
`build` is `electron-vite build`; the third step packages it. Artifacts land in
`packages/desktop/dist/`:

- `novaclaw-desktop-linux-<arch>.AppImage` (172 MB on arm64)
- `linux-<arch>-unpacked/` — the same app as a plain directory, whose executable is named after the
  channel's app id (`app.novaclaw.desktop` for prod, `…desktop.dev` for dev)

`NOVACLAW_CHANNEL` picks `dev` (the default), `beta` or `prod`. The channels use different app ids,
product names and data directories, so they can be installed side by side.

**`.deb`** — electron-builder refuses without a package maintainer, because `packages/desktop/package.json`
gives an author name but no email. Pass one:

```bash
bunx electron-builder --linux deb --config electron-builder.config.ts --publish never \
  -c.linux.maintainer="Your Name <you@example.com>"
```

That produced a 126 MB `.deb`. No `fakeroot` needed.

**`.rpm`** — the same maintainer rule, plus `rpmbuild` on the machine (`sudo apt-get install rpm`);
without it the packaging step fails with _Need executable 'rpmbuild' to convert dir to rpm_.

The build targets your host architecture. Cross-building (an arm64 package on an x64 host, or the
reverse) is _not verified here_.

Two harmless lines you will see in the log: `file source doesn't exist … packages/desktop/native`
(a macOS-only helper that is not built on Linux) and a bun dependency-tree note.

## 6. Where NovaClaw keeps its files

By default, the XDG layout:

```
~/.local/share/novaclaw     data
~/.config/novaclaw          config
~/.local/state/novaclaw     state
~/.cache/novaclaw           cache
```

`--home <dir>` (or `NOVACLAW_HOME`) overrides all four and puts `data/`, `config/`, `state/` and
`cache/` side by side inside one folder — so an instance is a single directory you can copy, move
or delete, and several instances can share a machine. The desktop app accepts the same flag.

## 7. Point it at a model

Nothing at build time. Start the app, open **Settings**, and add any OpenAI-compatible endpoint
(`/v1/chat/completions` + `/v1/models`) — vLLM, llama.cpp, LM Studio, Ollama, or a hosted key if
you bring one.

## 8. Bubblewrap: the sandbox for unattended sessions

On Linux, NovaClaw confines the `bash` tool inside a bubblewrap sandbox — one writable bind (the
session's folder), everything else read-only or masked, and no network — whenever the session has
no human watching it (an auto-prompting or goal-oriented chain). If no working sandbox exists,
those sessions are _denied_ raw shell access instead. Interactive sessions you are watching are
unaffected either way.

Check whether this host can enforce it — this is the exact probe NovaClaw runs:

```bash
bwrap --die-with-parent --unshare-all --ro-bind / / true; echo $?
```

`0` means confinement is available. On Ubuntu 23.10+ (`kernel.apparmor_restrict_unprivileged_userns=1`)
bubblewrap needs its own AppArmor profile, and many images ship without one — every sandbox then
fails. Install the standard stub, which is scoped to `bwrap` alone rather than disabling the sysctl
system-wide:

```bash
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Re-run the probe afterwards; it should print `0`.

## 9. Tests

```bash
bun run test
```

The fast hermetic suite — fourteen units, about 100 s. See [CONTRIBUTING.md](CONTRIBUTING.md) for
what a patch is expected to run.

**Know the baseline before you read your own results.** On the machine above, 13 of the 14 units
were green and `core` failed with 34 tests: about thirty of them in `SessionRunnerLLM` (the runner
never issues its provider request), plus `DatabaseMigration > declared schema has no ungenerated
migrations` and `SessionRead.list under …`. The same commit on Windows fails one test in `core`, so
these are a Linux gap in the tests, not something your checkout did. Judge a change by the suites it
touches, compared against a stashed baseline on the same machine.

The suite refuses to start if another build or suite is already running, or if the machine is low
on memory; `--force` overrides that.

## 10. Troubleshooting

| Symptom                                                         | Cause and fix                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.hash is not a function` during a Vite build             | Node older than 20.19. §1.                                                                                                                                                                                                                              |
| `error: preload not found "@opentui/solid/preload"`             | An older checkout: `packages/novaclaw/bunfig.toml` preloaded a package that is no longer a dependency. It survives on machines with stale `node_modules` and breaks every fresh Linux install — including the desktop build. Delete the `preload` line. |
| `dlopen(): error loading libfuse.so.2` when running an AppImage | Install `libfuse2t64`, or run it as `./novaclaw-desktop-linux-<arch>.AppImage --appimage-extract-and-run`.                                                                                                                                              |
| `It is required to set Linux .deb package maintainer`           | Pass `-c.linux.maintainer="Name <email>"`. §5.                                                                                                                                                                                                          |
| `Need executable 'rpmbuild' to convert dir to rpm`              | `sudo apt-get install rpm`.                                                                                                                                                                                                                             |
| `kb-memory failed to open` in the server log                    | The graph-memory engine is a dependency of the desktop app, so the standalone server cannot resolve it. Memory is disabled; everything else works.                                                                                                      |
| The port is taken                                               | The supervisor retries with backoff and gives up after five fast exits rather than fighting whatever holds the port. Free it, or pass a different `--port`.                                                                                             |
| `bun run test` reports `core` failing                           | Expected on Linux today — see §9 for the baseline. Compare against a stashed clean checkout before assuming your change caused it.                                                                                                                      |

## What was and was not verified

Run on Ubuntu 24.04.4 LTS (aarch64, kernel 6.17), Bun 1.3.14, Node 24.18.0:

- ✅ `bun install`
- ✅ the server from source, health endpoint answering
- ✅ `bun run dev:web` serving the app
- ✅ the single binary — built, `--version`, and serving the embedded UI over HTTP
- ✅ the server-only variant (`--skip-embed-web-ui`) built with Node 18 on `PATH`
- ✅ `novaclaw web --home <dir>` creating a self-contained instance folder
- ✅ the desktop `AppImage` and `.deb` builds, on the default `dev` channel — `NOVACLAW_CHANNEL=prod`
  changes only the app id, product name and data directory
- ✅ the bubblewrap probe with the AppArmor stub installed
- ✅ `bun run test` (see §9 for what it prints here)
- ⚠️ `.rpm` — fails without `rpmbuild`; not built here
- ⚠️ the GUI itself (`bun run dev:desktop`, launching the AppImage) — the test machine is headless
- ⚠️ x86-64 — every command above is architecture-agnostic, but the runs were on arm64
