#!/usr/bin/env bun
/**
 * Launches the PACKAGED desktop artifact against a throwaway home and asserts the handful of facts
 * that only the real binary can answer.
 *
 * WHY THIS EXISTS. Two packaging bugs have shipped, and both were invisible to a fully green suite:
 *
 *   · v0.0.1 — the version was a build-time define (`NOVACLAW_VERSION`). The Electron sidecar's
 *     `build-node.ts` only ever defined the CHANNEL, so the fallback silently won and the packaged
 *     app reported its version as the string **"local"** in `/health`, in session records and to
 *     Telegram. (AGENTS.md → *Version*. "local" is the honest answer for an UNBUILT tree, which is
 *     exactly why a packaged binary reporting it is a defect.)
 *   · v0.1.0 — `preferAppEnv` did `Object.assign(process.env, {XDG_DATA_HOME: undefined})`. Node
 *     coerces env values to strings, so that wrote the literal text `"undefined"`; being non-empty it
 *     passed every `??`/`||` fallback downstream, the server resolved its data directory to
 *     `undefined\novaclaw`, and **every session create 500'd**. (AGENTS.md → *Known pitfalls* #0.)
 *
 * The second one reproduced 200 OK from bun, from the Node bundle, on a virgin profile and against
 * the real database. ONLY the packaged Electron sidecar failed. The lesson recorded in AGENTS.md is
 * verbatim: *"a green suite proves nothing about the packaged app … **Smoke the artifact.**"* This
 * file is that sentence turned into a mechanism — informational levers engage, mechanical ones
 * convert — and it is wired in as step 4 of `build-desktop.bat` / `build-desktop-release.bat`, so a
 * build that reproduces either bug FAILS instead of shipping.
 *
 * Do not delete this as ceremony. Every assertion below is a bug that actually shipped, or the
 * signature of one.
 *
 * HOW IT REACHES THE APP FROM OUTSIDE. The packaged desktop picks an EPHEMERAL sidecar port and a
 * `randomUUID()` password per launch (`src/main/index.ts`), and the sidecar overwrites
 * `NOVACLAW_SERVER_PASSWORD` with that value in its own environment (`src/main/sidecar.ts`), so
 * neither is injectable or guessable from the outside. They ARE, however, handed to the renderer:
 * `window.api.awaitInitialization()` resolves to `{url, username, password}`. So we launch the exe
 * with `--remote-debugging-port` and ask the renderer for its own credentials over CDP — which has
 * the pleasant side effect of also proving the window opened at all.
 *
 * Usage:  bun ./scripts/smoke-artifact.ts [path\to\NovaClaw.exe]
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

import { canonicalVersion, type Channel } from "./utils"
import { channelConfigured, resolveChannel } from "../../../script/lib/channel"

/** How long the app gets to boot, open a window and answer /global/health. */
const READY_TIMEOUT_MS = 90_000
/** Per-HTTP-request budget once the server is up. */
const REQUEST_TIMEOUT_MS = 20_000

// ── failures ────────────────────────────────────────────────────────────────────────────────────

const failures: string[] = []
/** Record a named failure. Everything is collected so one run reports EVERY broken thing. */
function check(ok: boolean, name: string, detail: string) {
  if (ok) {
    console.log(`  ok    ${name}`)
    return true
  }
  console.log(`  FAIL  ${name} — ${detail}`)
  failures.push(`${name}: ${detail}`)
  return false
}

// ── artifact discovery ──────────────────────────────────────────────────────────────────────────

/** `dist/<dir>` holding the unpacked app, per platform, plus how an executable looks there. */
function unpackedDir(): string {
  if (process.platform === "win32") return "win-unpacked"
  if (process.platform === "linux") return "linux-unpacked"
  return "mac"
}

/**
 * The packaged executable. An explicit argv path wins; otherwise look under
 * `packages/desktop/dist/<platform>-unpacked/`, preferring a NovaClaw-named binary.
 *
 * A missing artifact is a HARD failure, never a silent pass: "the smoke step passed because there
 * was nothing to smoke" is precisely the defect class this file exists to close.
 */
function resolveExe(explicit: string | undefined): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`no artifact at the given path: ${explicit}`)
    return path.resolve(explicit)
  }
  const dir = path.resolve(import.meta.dir, "..", "dist", unpackedDir())
  if (!existsSync(dir)) throw new Error(`no packaged artifact: ${dir} does not exist — run the build before the smoke`)
  const entries = readdirSync(dir).filter((name) => {
    if (process.platform === "win32") return name.toLowerCase().endsWith(".exe")
    if (name.includes(".")) return false
    try {
      return statSync(path.join(dir, name)).isFile()
    } catch {
      return false
    }
  })
  const preferred = entries.find((name) => name.toLowerCase().startsWith("novaclaw")) ?? entries[0]
  if (!preferred) throw new Error(`no executable found under ${dir} — run the build before the smoke`)
  return path.join(dir, preferred)
}

/**
 * The channel this artifact is SUPPOSED to be. An explicit `NOVACLAW_CHANNEL` wins (both build
 * scripts run under one — the release script sets `prod`); otherwise it is inferred from the
 * executable's name, which is how electron-builder stamps the channel into the artifact
 * (`NovaClaw Dev.exe` / `NovaClaw Beta.exe` / `NovaClaw.exe`, see `APP_NAMES` in `src/main/index.ts`).
 * `resolveChannel()` alone would answer "dev" for an unset env, which is the right default for a
 * BUILD and the wrong one for reading an artifact off disk.
 */
function expectedChannel(exe: string): Channel {
  // `channelConfigured()` rather than reading the env var here: script/lib/channel.ts owns that
  // variable outright, so this file asks "was one configured?" and lets the resolver say what it MEANS
  // (including the "latest" alias, and refusing a typo instead of silently calling it dev).
  if (channelConfigured()) return resolveChannel()
  const name = path
    .basename(exe)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  if (name.endsWith("dev")) return "dev"
  if (name.endsWith("beta")) return "beta"
  return "prod"
}

/**
 * Run the package outside the checkout. Node resolves a dependency missing from app.asar by walking
 * parent directories; launching dist/win-unpacked in-tree therefore let the workspace node_modules
 * mask a broken release. The v0.1.55 PTY omission passed the old smoke for exactly that reason.
 */
async function stageArtifact(exe: string, root: string): Promise<string> {
  let packageRoot = path.dirname(exe)
  if (process.platform === "darwin") {
    let cursor = path.resolve(exe)
    for (;;) {
      if (cursor.toLowerCase().endsWith(".app")) {
        packageRoot = cursor
        break
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new Error(`could not find the .app bundle containing ${exe}`)
      cursor = parent
    }
  }

  const stagedRoot = path.join(root, "artifact", path.basename(packageRoot))
  await cp(packageRoot, stagedRoot, { recursive: true, force: false, errorOnExist: true })
  return path.join(stagedRoot, path.relative(packageRoot, exe))
}

/**
 * The database filename the server must report for a given channel. Mirrors
 * `packages/core/src/database/db-path.ts` — and it is the ONLY externally-visible statement of the
 * channel the running binary was built with (no route reports the channel itself; `/path`'s own
 * comment notes `db` "is channel-dependent … so it cannot be derived client-side"). A binary built
 * without the `NOVACLAW_CHANNEL` define reports `novaclaw-local.db` here, which is the packaging
 * failure this assertion is for.
 */
function expectedDbBasename(channel: string): string {
  if (["latest", "beta", "prod"].includes(channel)) return "novaclaw.db"
  return `novaclaw-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
}

// ── path predicates ─────────────────────────────────────────────────────────────────────────────

/** True when `child` is `parent` or lives underneath it. Case-insensitive on Windows via path.relative. */
function insideOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Pitfall #0's signature: a path SEGMENT that is literally `undefined`. Case-sensitive and
 * segment-wise on purpose — a real directory could legitimately be called "Undefined" or
 * "undefined-things", and neither is the bug.
 */
function hasUndefinedSegment(value: string): boolean {
  return value.split(/[\\/]/).includes("undefined")
}

// ── process control ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill by TREE. AGENTS.md pitfall #8 is absolute: the Electron main spawns a sidecar utility process
 * which spawns MCP node children, so a bare pid kill orphans two more layers — and orphans on this
 * box accumulate at GBs each until the machine dies. `/t` is not optional.
 */
function killTree(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
}

/** A free localhost port, taken the same way `src/main/index.ts` takes the sidecar's. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close()
        reject(new Error("could not reserve a debugging port"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── CDP ─────────────────────────────────────────────────────────────────────────────────────────

type CdpTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string }

/** Evaluate an expression in a renderer target and return its (JSON-serializable) value. */
function cdpEvaluate(wsUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error("CDP evaluate timed out"))), timeoutMs)
    socket.onerror = () => finish(() => reject(new Error(`CDP socket error on ${wsUrl}`)))
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
    }
    socket.onmessage = (event: MessageEvent) => {
      let message: {
        id?: number
        error?: { message?: string }
        result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      if (message.error) return finish(() => reject(new Error(`CDP error: ${message.error?.message}`)))
      const details = message.result?.exceptionDetails
      if (details) return finish(() => reject(new Error(`evaluate threw: ${details.text}`)))
      finish(() => resolve(message.result?.result?.value))
    }
  })
}

type Credentials = { url: string; username?: string; password?: string }
type Renderer = { credentials: Credentials; wsUrl: string }

/**
 * Ask the renderer for the sidecar's URL + credentials. `window.api.awaitInitialization()` is the
 * same call the app itself makes to build its "Local Server" connection (`src/renderer/index.tsx`),
 * so this reads the real values rather than re-deriving them. Returned as a JSON STRING so the value
 * crosses `returnByValue` as plain data and never as a contextBridge proxy.
 */
async function readRenderer(devtoolsPort: number, deadline: number): Promise<Renderer> {
  const expression = `(async () => {
    const api = globalThis.window && window.api
    if (!api || typeof api.awaitInitialization !== "function") throw new Error("window.api is not exposed yet")
    const data = await api.awaitInitialization()
    return JSON.stringify({ url: data.url, username: data.username, password: data.password })
  })()`

  let lastError = "the app never exposed a debuggable renderer"
  while (Date.now() < deadline) {
    let targets: CdpTarget[] = []
    try {
      const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) targets = (await res.json()) as CdpTarget[]
    } catch (error) {
      lastError = `devtools endpoint not up: ${String(error)}`
    }
    for (const target of targets) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue
      if (target.url?.startsWith("devtools://")) continue
      try {
        const raw = await cdpEvaluate(target.webSocketDebuggerUrl, expression, 15_000)
        const parsed = JSON.parse(String(raw)) as Credentials
        if (typeof parsed.url === "string" && parsed.url.length > 0)
          return { credentials: parsed, wsUrl: target.webSocketDebuggerUrl }
        lastError = `renderer returned no server url (${String(raw)})`
      } catch (error) {
        lastError = String(error)
      }
    }
    await sleep(500)
  }
  throw new Error(`could not read the sidecar credentials from the app: ${lastError}`)
}

async function readToastSelection(wsUrl: string) {
  const raw = await cdpEvaluate(
    wsUrl,
    `(() => {
      const host = document.createElement("div")
      host.style.userSelect = "none"
      const probe = (component, titleSlot, descriptionSlot) => {
        const root = document.createElement("div")
        root.dataset.component = component
        const title = document.createElement("div")
        title.dataset.slot = titleSlot
        title.textContent = "Failed to reload project"
        const description = document.createElement("div")
        description.dataset.slot = descriptionSlot
        description.textContent = "Diagnostic reference: err_12345678."
        root.append(title, description)
        host.append(root)
        return { title, description }
      }
      const legacy = probe("toast", "toast-title", "toast-description")
      const current = probe("toast-v2", "toast-v2-title", "toast-v2-description")
      document.body.append(host)
      const range = document.createRange()
      range.selectNodeContents(current.description)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const result = {
        legacyTitle: getComputedStyle(legacy.title).userSelect,
        legacyDescription: getComputedStyle(legacy.description).userSelect,
        currentTitle: getComputedStyle(current.title).userSelect,
        currentDescription: getComputedStyle(current.description).userSelect,
        selected: selection.toString(),
      }
      selection.removeAllRanges()
      host.remove()
      return JSON.stringify(result)
    })()`,
    15_000,
  )
  return JSON.parse(String(raw)) as Record<string, string>
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────

function authHeader(credentials: Credentials): Record<string, string> {
  if (!credentials.password) return {}
  const raw = `${credentials.username ?? "novaclaw"}:${credentials.password}`
  return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` }
}

async function request(
  credentials: Credentials,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(new URL(route, credentials.url), {
    method,
    headers: {
      ...authHeader(credentials),
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await sleep(50)
  }
  return !processAlive(pid)
}

/** Open the same ticketed socket as the Terminal app and return a child pid emitted by the shell. */
function exercisePtySocket(url: URL, timeoutMs = 15_000): Promise<{ childPID: number; output: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    const decoder = new TextDecoder()
    let output = ""
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close(1000, "artifact smoke complete")
      } catch {
        /* already closed */
      }
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`PTY socket timed out; output: ${output.slice(-500)}`))),
      timeoutMs,
    )
    socket.onerror = () => finish(() => reject(new Error(`PTY socket error on ${url}`)))
    socket.onclose = () => {
      if (!settled)
        finish(() => reject(new Error(`PTY socket closed before the marker; output: ${output.slice(-500)}`)))
    }
    socket.onopen = () => {
      // The marker is octal-escaped so terminal echo cannot satisfy the assertion. `sleep` remains
      // alive as a descendant, letting the remove step prove tree cleanup rather than shell-only exit.
      socket.send(
        `sleep 300 & printf '\\116\\117\\126\\101\\103\\114\\101\\127\\137\\120\\124\\131\\137\\117\\113\\072%s\\n' "$!"\r`,
      )
    }
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") output += event.data
      else if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data)
        if (bytes[0] !== 0) output += decoder.decode(bytes)
      }
      const match = output.match(/NOVACLAW_PTY_OK:(\d+)/)
      if (!match) return
      const childPID = Number(match[1])
      finish(() => resolve({ childPID, output }))
    }
  })
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

const logTail: string[] = []
function remember(label: string, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    logTail.push(`[${label}] ${line}`)
    if (logTail.length > 120) logTail.shift()
  }
}

function drain(stream: unknown, label: string) {
  if (!stream || typeof stream !== "object" || !("getReader" in stream)) return
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) remember(label, decoder.decode(value, { stream: true }))
      }
    } catch {
      /* the pipe dies with the child; nothing to report */
    }
  })()
}

/**
 * Environment for the artifact. Deliberately STRIPPED of every knob that would answer a question the
 * artifact is supposed to answer for itself — an inherited `NOVACLAW_DB` or `NOVACLAW_DISABLE_CHANNEL_DB`
 * would silently defeat the channel assertion, and an inherited `NOVACLAW_PORT` would pin the sidecar
 * onto a port something else may hold.
 */
function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const key of [
    "NOVACLAW_PORT",
    "NOVACLAW_DB",
    "NOVACLAW_CONFIG_DIR",
    "NOVACLAW_TEST_HOME",
    "NOVACLAW_SCRATCH_ROOT",
    "NOVACLAW_DEV_ISOLATED",
    "NOVACLAW_DISABLE_CHANNEL_DB",
    "NOVACLAW_TEST_ONBOARDING",
    "NOVACLAW_WORKSPACE_ID",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
  ])
    delete env[key]
  env.NOVACLAW_HOME = home
  // A portable/dev build has no update feed; checking for one only produces noise in a smoke.
  env.NOVACLAW_DISABLE_AUTOUPDATE = "1"
  return env
}

let child: ReturnType<typeof Bun.spawn> | undefined
let tempHome: string | undefined
let tornDown = false

async function teardown() {
  if (tornDown) return
  tornDown = true
  if (child?.pid) {
    console.log(`\nstopping the app (tree kill, pid ${child.pid})…`)
    killTree(child.pid)
    await sleep(1_000)
  }
  if (!tempHome) return
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await rm(tempHome, { recursive: true, force: true })
      return
    } catch {
      await sleep(500)
    }
  }
  console.log(`WARNING: could not remove the temp home ${tempHome} — delete it by hand`)
}

// Teardown has to happen on EVERY exit path. The async version covers the normal ones; the
// synchronous `exit` hook is the last-ditch guarantee that no Electron tree outlives this script.
process.on("SIGINT", () => void teardown().finally(() => process.exit(130)))
process.on("SIGTERM", () => void teardown().finally(() => process.exit(143)))
process.on("exit", () => {
  if (!tornDown && child?.pid) killTree(child.pid)
})

async function run() {
  const sourceExe = resolveExe(process.argv[2])
  const channel = expectedChannel(sourceExe)
  const version = await canonicalVersion()
  console.log(`artifact : ${sourceExe}`)
  console.log(`channel  : ${channel} (expected)`)
  console.log(`version  : ${version} (canonical, from the root package.json)`)

  tempHome = await mkdtemp(path.join(os.tmpdir(), "novaclaw-smoke-"))
  const exe = await stageArtifact(sourceExe, tempHome)
  console.log(`staged   : ${exe} (isolated from workspace dependencies)`)
  if (process.platform === "win32") {
    const kit = path.join(path.dirname(exe), "resources", "third-party", "w64devkit")
    const bin = path.join(kit, "bin")
    const critical = ["sh.exe", "busybox.exe", "gcc.exe", "as.exe", "ld.exe", "make.exe"]
    for (const name of critical)
      check(existsSync(path.join(bin, name)), `w64devkit-${name}`, `missing ${path.join(bin, name)}`)
    check(existsSync(path.join(kit, "VERSION.txt")), "w64devkit-version", `missing ${path.join(kit, "VERSION.txt")}`)
    check(
      existsSync(path.join(kit, "COPYING.MinGW-w64-runtime.txt")),
      "w64devkit-license",
      "the embedded MinGW-w64 runtime licence is missing",
    )

    const shell = spawnSync(path.join(bin, "sh.exe"), ["-lc", "printf NOVACLAW_PACKAGED_SH_OK"], {
      cwd: tempHome,
      encoding: "utf8",
    })
    check(
      shell.status === 0 && shell.stdout === "NOVACLAW_PACKAGED_SH_OK",
      "w64devkit-shell-run",
      `ash exited ${String(shell.status)}: ${shell.stderr || shell.stdout}`,
    )

    const source = path.join(tempHome, "packaged-toolchain-smoke.c")
    const program = path.join(tempHome, "packaged-toolchain-smoke.exe")
    await writeFile(source, '#include <stdio.h>\nint main(void){fputs("NOVACLAW_PACKAGED_GCC_OK",stdout);return 0;}\n')
    const compilerEnv = { ...process.env }
    const pathKey = Object.keys(compilerEnv).find((key) => key.toLowerCase() === "path") ?? "Path"
    compilerEnv[pathKey] = `${bin}${path.delimiter}${compilerEnv[pathKey] ?? ""}`
    const compiled = spawnSync(path.join(bin, "gcc.exe"), ["-std=c99", source, "-o", program], {
      cwd: tempHome,
      encoding: "utf8",
      env: compilerEnv,
    })
    check(
      compiled.status === 0 && existsSync(program),
      "w64devkit-c99-compile",
      `GCC exited ${String(compiled.status)}: ${compiled.stderr || compiled.stdout}`,
    )
    const executed = existsSync(program) ? spawnSync(program, [], { encoding: "utf8" }) : undefined
    check(
      executed?.status === 0 && executed.stdout === "NOVACLAW_PACKAGED_GCC_OK",
      "w64devkit-c99-run",
      `compiled program exited ${String(executed?.status)}: ${executed?.stderr || executed?.stdout || "not run"}`,
    )
  }
  const authSeed = process.env.NOVACLAW_SMOKE_AUTH_FILE
  const keySeed = process.env.NOVACLAW_SMOKE_CREDENTIAL_KEY
  if (!!authSeed !== !!keySeed)
    throw new Error("NOVACLAW_SMOKE_AUTH_FILE and NOVACLAW_SMOKE_CREDENTIAL_KEY must be provided together")
  if (authSeed && keySeed) {
    await mkdir(path.join(tempHome, "data"), { recursive: true })
    await mkdir(path.join(tempHome, "state"), { recursive: true })
    await copyFile(authSeed, path.join(tempHome, "data", "auth.json"))
    await copyFile(keySeed, path.join(tempHome, "state", "credential.key"))
    console.log("seed     : encrypted auth + credential key (copied into throwaway home)")
  }
  const devtoolsPort = await freePort()
  console.log(`home     : ${tempHome}`)
  console.log(`devtools : 127.0.0.1:${devtoolsPort}\n`)

  child = Bun.spawn({
    cmd: [
      exe,
      "--home",
      tempHome,
      `--remote-debugging-port=${devtoolsPort}`,
      // Chromium refuses debugger websockets carrying an unlisted Origin header; the debugging port
      // is loopback-only and this instance is a throwaway.
      "--remote-allow-origins=*",
    ],
    env: childEnv(tempHome),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  drain(child.stdout, "out")
  drain(child.stderr, "err")

  const deadline = Date.now() + READY_TIMEOUT_MS
  const renderer = await readRenderer(devtoolsPort, deadline)
  const credentials = renderer.credentials
  console.log(`sidecar  : ${credentials.url}\n`)

  // The desktop shell is deliberately select-none almost everywhere. Diagnostic popup text is the
  // exception: a user must be able to drag-select the explanation and reference to share it with an
  // agent or another person. Probe the COMPUTED CSS in the packaged renderer (not a copied source
  // string), under an explicitly unselectable parent, and exercise a real DOM selection too.
  try {
    const selection = await readToastSelection(renderer.wsUrl)
    for (const key of ["legacyTitle", "legacyDescription", "currentTitle", "currentDescription"])
      check(selection[key] === "text", `toast-selectable-${key}`, `expected user-select:text, got ${selection[key]}`)
    check(
      selection.selected === "Diagnostic reference: err_12345678.",
      "toast-selection-content",
      `the browser selected ${JSON.stringify(selection.selected)}`,
    )
  } catch (error) {
    check(false, "toast-selection", `could not inspect packaged popup selection: ${String(error)}`)
  }

  // ── 1. health: the app is up, and it knows what it is ──────────────────────────────────────────
  let health: { healthy?: boolean; version?: string; instanceID?: string } | undefined
  for (;;) {
    try {
      const res = await request(credentials, "GET", "/global/health")
      if (res.status === 200) {
        health = res.json as typeof health
        break
      }
      if (Date.now() > deadline) {
        check(false, "health", `/global/health answered ${res.status}: ${res.text.slice(0, 200)}`)
        break
      }
    } catch (error) {
      if (Date.now() > deadline) {
        check(false, "health", `/global/health never answered: ${String(error)}`)
        break
      }
    }
    await sleep(500)
  }

  if (health) {
    check(health.healthy === true, "health", `expected healthy:true, got ${JSON.stringify(health)}`)
    // v0.0.1's bug, exactly: a packaged binary reporting the unbuilt-tree fallback.
    check(
      health.version !== "local",
      "version-not-local",
      `the packaged app reports version "local" — the version define/constant did not reach the sidecar bundle`,
    )
    check(
      health.version === version,
      "version-matches-canonical",
      `expected ${version} (root package.json), got ${String(health.version)}`,
    )
  }

  // ── 2. paths: --home was honoured, and no "undefined" got into a path ──────────────────────────
  let paths: Record<string, unknown> | undefined
  try {
    const res = await request(credentials, "GET", "/path")
    if (res.status === 200) paths = res.json as Record<string, unknown>
    else check(false, "paths", `/path answered ${res.status}: ${res.text.slice(0, 200)}`)
  } catch (error) {
    check(false, "paths", `/path failed: ${String(error)}`)
  }

  let scratchDir: string | undefined
  if (paths) {
    const home = tempHome
    const strings = Object.entries(paths).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    // THE pitfall-#0 signature. Checked over every path the server reports, not just `data`,
    // because in v0.1.0 three XDG variables were poisoned at once and each fanned out.
    const poisoned = strings.filter(([, value]) => hasUndefinedSegment(value))
    check(
      poisoned.length === 0,
      "no-undefined-path-segment",
      `these reported paths contain an "undefined" segment: ${poisoned
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    )

    // `home` and `tmp` are deliberately NOT in this list: `home` is os.homedir() and `tmp` is
    // os.tmpdir()/novaclaw by design, neither of which moves with --home.
    for (const key of ["data", "config", "state", "cache", "log", "db", "scratchDir"]) {
      const value = paths[key]
      if (typeof value !== "string") {
        check(false, `home-contains-${key}`, `/path did not report a string "${key}"`)
        continue
      }
      check(insideOrEqual(home, value), `home-contains-${key}`, `expected a path under ${home}, got ${value}`)
    }
    check(
      typeof paths.instanceHome === "string" && insideOrEqual(home, paths.instanceHome),
      "instance-home",
      `expected instanceHome ${home}, got ${String(paths.instanceHome)}`,
    )

    const db = typeof paths.db === "string" ? path.basename(paths.db) : undefined
    check(
      db === expectedDbBasename(channel),
      "channel",
      `expected the ${channel} database file ${expectedDbBasename(channel)}, got ${String(db)} ` +
        `(the database filename is the only externally-visible statement of the built channel)`,
    )

    if (typeof paths.scratchDir === "string") scratchDir = paths.scratchDir
  }

  // ── 3. create a session — the exact request that 500'd in v0.1.0 ───────────────────────────────
  // The failing click was the home prompt bar, which creates a folder-less agent at the scratch
  // directory (`<data>/scratch`), i.e. the one path most directly downstream of the poisoned data dir.
  try {
    const payload = scratchDir ? { location: { directory: scratchDir } } : {}
    const res = await request(credentials, "POST", "/api/session", payload)
    const created = (res.json as { data?: { id?: string } } | undefined)?.data?.id
    check(
      res.status >= 200 && res.status < 300,
      "session-create",
      `POST /api/session answered ${res.status}: ${res.text.slice(0, 400)}`,
    )
    if (res.status >= 200 && res.status < 300)
      check(
        typeof created === "string",
        "session-create-id",
        `no session id in the response: ${res.text.slice(0, 200)}`,
      )
  } catch (error) {
    check(false, "session-create", `POST /api/session failed: ${String(error)}`)
  }

  // ── 4. PTY runtime is genuinely packaged ───────────────────────────────────────────────────────
  // Merely booting is insufficient now that PTY is correctly lazy. v0.1.55 initially omitted the
  // generic @lydell/node-pty loader; an in-tree smoke found it in the workspace and passed, while a
  // downloaded copy failed. Staging above closes the resolution leak; creating one PTY proves both
  // the generic loader and the platform-native package made it into the artifact. Exercise the
  // canonical `/api/pty` contract: this is the exact surface used by the Terminal renderer, so this
  // gate must not pass by keeping the retired legacy transport alive beside a broken product route.
  if (scratchDir) {
    const location = `?location%5Bdirectory%5D=${encodeURIComponent(scratchDir)}`
    let ptyID: string | undefined
    let ptyPID: number | undefined
    let childPID: number | undefined
    try {
      const res = await request(credentials, "POST", `/api/pty${location}`, {
        cwd: scratchDir,
        title: "Artifact smoke",
      })
      const info = (res.json as { data?: { id?: string; pid?: number } } | undefined)?.data
      ptyID = info?.id
      ptyPID = info?.pid
      check(
        res.status >= 200 && res.status < 300 && typeof ptyID === "string",
        "pty-create",
        `POST /api/pty answered ${res.status}: ${res.text.slice(0, 400)}`,
      )

      if (ptyID) {
        const token = await request(
          credentials,
          "POST",
          `/api/pty/${encodeURIComponent(ptyID)}/connect-token${location}`,
          undefined,
          { "x-novaclaw-ticket": "1" },
        )
        const ticket = (token.json as { data?: { ticket?: string } } | undefined)?.data?.ticket
        check(
          token.status === 200 && typeof ticket === "string",
          "pty-websocket-ticket",
          `connect-token answered ${token.status}: ${token.text.slice(0, 300)}`,
        )
        if (ticket) {
          const socketURL = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect${location}`, credentials.url)
          socketURL.protocol = socketURL.protocol === "https:" ? "wss:" : "ws:"
          socketURL.searchParams.set("cursor", "-1")
          socketURL.searchParams.set("ticket", ticket)
          const exchange = await exercisePtySocket(socketURL)
          childPID = exchange.childPID
          check(
            exchange.output.includes(`NOVACLAW_PTY_OK:${childPID}`),
            "pty-websocket-io",
            exchange.output.slice(-500),
          )
          check(processAlive(childPID), "pty-child-running", `reported child process ${childPID} was not alive`)
          if (ptyPID !== undefined && ptyPID > 0)
            check(processAlive(ptyPID), "pty-shell-running", `reported shell process ${ptyPID} was not alive`)
        }
      }
    } catch (error) {
      check(false, ptyID ? "pty-websocket-io" : "pty-create", String(error))
    } finally {
      if (ptyID) {
        const removed = await request(credentials, "DELETE", `/api/pty${location}`).catch(() => undefined)
        const removedCount = (removed?.json as { data?: number } | undefined)?.data
        check(
          removed?.status === 200 && typeof removedCount === "number" && removedCount >= 1,
          "pty-stop-all",
          `expected a 200 location-wrapped count >= 1, got ${String(removed?.status)} ${removed?.text ?? ""}`,
        )
        if (ptyPID !== undefined && ptyPID > 0)
          check(await waitForProcessExit(ptyPID), "pty-shell-stopped", `shell process ${ptyPID} survived PTY removal`)
        if (childPID !== undefined)
          check(
            await waitForProcessExit(childPID),
            "pty-child-stopped",
            `child process ${childPID} survived PTY removal`,
          )
      }
    }
  } else {
    check(false, "pty-create", "scratchDir was unavailable, so the packaged PTY runtime could not be exercised")
  }

  // ── 5. memory (the kb graph) is actually up ────────────────────────────────────────────────────
  try {
    const res = await request(credentials, "GET", "/memory/stats")
    const stats = res.json as { total?: unknown; valid?: unknown } | undefined
    check(
      res.status === 200 && typeof stats?.total === "number" && typeof stats?.valid === "number",
      "memory-enabled",
      `GET /memory/stats answered ${res.status}: ${res.text.slice(0, 200)}`,
    )
  } catch (error) {
    check(false, "memory-enabled", `GET /memory/stats failed: ${String(error)}`)
  }
}

let fatal: string | undefined
try {
  await run()
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
} finally {
  await teardown()
}

if (fatal) failures.unshift(`smoke could not run: ${fatal}`)

if (failures.length > 0) {
  if (logTail.length > 0) {
    console.log("\n--- last output from the app ---")
    for (const line of logTail) console.log(line)
  }
  console.log("\nARTIFACT SMOKE FAILED:")
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}

console.log("\nartifact smoke passed")
process.exit(0)
