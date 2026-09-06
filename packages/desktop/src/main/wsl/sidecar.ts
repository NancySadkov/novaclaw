import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { checkHealth } from "../server"
import { type WslCommandLine, resolveWslNovaclaw, shellEscape, wslArgs } from "./runtime"
import { pollWslHealth } from "./startup"

/** How long a distro's server gets to exit on its own before the harder signal. */
const STOP_GRACE_MS = 3_000

export type WslSidecar = {
  listener: {
    /**
     * 🔴 **NC-REL-001 — `stop` used to return before the child had gone.** It was
     * `() => child.kill()`: a signal, then immediate return. Quit is advertised and implemented as a
     * bounded wait over `stopSidecars()`, but there was nothing to wait ON for a WSL instance, so the
     * app could exit while a distro's server was still mid-write. Returning a promise is what lets the
     * quit chain mean what it says.
     */
    stop: () => void | Promise<void>
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(
  distro: string,
  opts: { onLine?: (line: WslCommandLine) => void; healthTimeoutMs?: number; spawn?: typeof spawn } = {},
): Promise<WslSidecar> {
  const novaclaw = await resolveWslNovaclaw(distro)
  if (!novaclaw) throw new Error(`NovaClaw is not installed in ${distro}`)

  const port = await allocatePort()
  const password = randomUUID()
  const username = "novaclaw"
  const script = [
    "set -euo pipefail",
    'cd "$HOME" || cd /',
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    "export NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
    "export NOVACLAW_CLIENT=desktop",
    `export NOVACLAW_SERVER_USERNAME=${shellEscape(username)}`,
    `export NOVACLAW_SERVER_PASSWORD=${shellEscape(password)}`,
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `exec ${shellEscape(novaclaw)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 0.0.0.0 --port ${port}`,
  ].join("\n")
  const child = (opts.spawn ?? spawn)("wsl", wslArgs(["bash", "-se"], distro), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  // Own cleanup from acquisition, including startup failure. `close` also arrives after a spawn
  // error, and observes closed stdio as well as process exit.
  let closed = false
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true
      resolve()
    }),
  )
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return stopping
    if (closed) return Promise.resolve()
    const forced = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
    stopping = exited.finally(() => clearTimeout(forced))
    child.kill()
    return stopping
  }
  child.stdin.end(script)

  const recentOutput: string[] = []
  const emit = (line: WslCommandLine) => {
    if (!line.text.trim()) return
    recentOutput.push(`[${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }
  forwardLines(child.stdout, "stdout", emit)
  forwardLines(child.stderr, "stderr", emit)

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(startupFailure(code, signal, recentOutput))))
  })
  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const health = pollWslHealth(() => checkHealth(url, password), startup.signal)
  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Sidecar for ${distro} health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )),
  )

  await Promise.race([health, exit, timedOut])
    .catch(async (error) => {
      await stop()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      startup.abort()
    })
  return {
    listener: {
      stop,
      onExit: (cb) => child.once("exit", cb),
    },
    url,
    username,
    password,
  }
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    lines.forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return `WSL server exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`
}
