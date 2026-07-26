/**
 * Run the web app AND the backend it talks to, as one process tree.
 *
 * In dev the app hardcodes `http://localhost:4096` as its server, so `vite` alone renders
 * "Connection lost — reconnecting…" — which reads as a broken app rather than a missing backend. They were
 * two separate launch entries, so starting the app started only half the product. This runs both.
 *
 * Two properties worth keeping:
 *   · REUSE — if something is already serving 4096 (a serve you started yourself, or the desktop app), we
 *     attach to it rather than starting a second one that would fail to bind.
 *   · TREE KILL — the serve supervises a child process, so killing only the parent leaves an orphan holding
 *     nothing and serving nothing. That exact failure produced "listening on 3000, dead on 4096" more than
 *     once. On Windows only `taskkill /T` reliably takes the whole tree.
 */
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

const API_PORT = 4096
const REPO = path.resolve(import.meta.dir, "..", "..", "..") // …/novaclaw
const PROBE = `http://127.0.0.1:${API_PORT}/api/recipe`

const alreadyServing = async (): Promise<boolean> => {
  try {
    const res = await fetch(PROBE, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const children: ChildProcess[] = []

/** Kill a process AND its descendants. `child.kill()` alone orphans the serve's supervised child. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref()
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

function shutdown(code: number): never {
  for (const child of children) killTree(child)
  process.exit(code)
}

const prefix = (label: string, stream: NodeJS.ReadableStream | null) => {
  stream?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n"))
      if (line.trim()) process.stdout.write(`[${label}] ${line}\n`)
  })
}

if (await alreadyServing()) {
  process.stdout.write(`[backend] reusing the server already on :${API_PORT}\n`)
} else {
  process.stdout.write(`[backend] starting on :${API_PORT}…\n`)
  const backend = spawn(
    "bun",
    ["run", "--conditions=browser", "packages/novaclaw/src/index.ts", "serve", "--port", String(API_PORT)],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
  )
  children.push(backend)
  prefix("backend", backend.stdout)
  prefix("backend", backend.stderr)
  backend.on("exit", (code) => {
    // The app is useless without it — fail loudly rather than leaving the user at "Connection lost".
    process.stdout.write(`[backend] exited (${code}) — the app cannot reach a server\n`)
  })
  // Give it a moment to bind so the app's first request does not land on a closed port.
  for (let i = 0; i < 40 && !(await alreadyServing()); i += 1) await Bun.sleep(250)
}

const vite = spawn("bunx", ["vite"], {
  cwd: path.resolve(import.meta.dir, ".."),
  stdio: ["ignore", "inherit", "inherit"],
  shell: process.platform === "win32",
})
children.push(vite)
vite.on("exit", (code) => shutdown(code ?? 0))

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(0))
process.on("exit", () => {
  for (const child of children) killTree(child)
})
