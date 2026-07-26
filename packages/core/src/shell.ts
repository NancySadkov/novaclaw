export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { ShellBundle } from "./shell-bundle"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.NOVACLAW_GIT_BASH_PATH) return Flag.NOVACLAW_GIT_BASH_PATH
  // B11: a provisioned bundle IS the standard agent environment — it outranks the
  // system git-bash (the env flag above stays the explicit escape hatch).
  const bundled = ShellBundle.resolve()?.bash
  if (bundled) return bundled
  // A SYSTEM git-for-windows install. `which("git")` lands on whichever of git's several PATH
  // entries comes first — `<root>/cmd/git.exe`, `<root>/bin/git.exe` OR `<root>/mingw64/bin/git.exe`
  // — so WALK UP from the resolved binary and test both bash homes at each ancestor instead of
  // assuming one fixed depth. ⚠️ Measured 2026-07-26: with `mingw64\bin` first on PATH the old
  // fixed `../../bin/bash.exe` missed, this returned undefined, and every agent silently got
  // cmd.exe while the tool description and every recipe promised bash — the same prompt scored
  // 1/100 π digits under cmd.exe and 100/100 under bash.
  const candidates: string[] = []
  const git = which("git")
  if (git) {
    let dir = path.dirname(git)
    for (let i = 0; i < 4; i++) {
      candidates.push(path.join(dir, "bin", "bash.exe"), path.join(dir, "usr", "bin", "bash.exe"))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // A bash already on PATH counts only when it sits in an MSYS layout (`<root>/bin` or
  // `<root>/usr/bin`). That test is what rejects `…\WindowsApps\bash.exe` — the WSL launcher stub,
  // which would run the agent's commands inside a Linux VM against a different filesystem.
  const onPath = which("bash")
  if (onPath && ShellBundle.msysRoot(onPath)) candidates.push(onPath)
  for (const file of candidates) if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "novaclaw",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "novaclaw",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined
let defaultAgent: string | undefined

/**
 * B11 — the AGENT default shell: bash wherever one exists (the bundled PortableGit
 * first on Windows, then system git-bash), because small models are trained
 * overwhelmingly on bash. Platform fallbacks (COMSPEC / /bin/sh) apply only when no
 * bash is found. The HUMAN terminal default (`preferred`) is deliberately unchanged.
 */
export function agentDefault(): string {
  defaultAgent ??= (() => {
    if (process.platform === "win32") return gitbash() ?? process.env.COMSPEC ?? "cmd.exe"
    return which("bash") ?? "/bin/sh"
  })()
  return defaultAgent
}
agentDefault.reset = () => {
  defaultAgent = undefined
  warnedFallback = false
}

let warnedFallback = false
/**
 * TRUE when the agent shell is NOT bash — i.e. the fallback fired and every prompt that tells the
 * model "your shell is bash" is now lying to it. A silent fallback is the expensive failure: the
 * model writes POSIX, cmd.exe answers, and the task dies of unrelated-looking errors. Callers that
 * hand the shell to a model surface this instead of guessing (`bashFallbackNote`), and the first
 * call also logs it once for the server operator.
 */
export function agentShellIsBash(): boolean {
  return name(agentDefault()) === "bash"
}

/** One line for the agent's system prompt when its shell is not bash, else undefined. */
export function bashFallbackNote(): string | undefined {
  if (agentShellIsBash()) return undefined
  const shell = agentDefault()
  if (!warnedFallback) {
    warnedFallback = true
    console.warn(
      `[shell] no bash found — agent commands will run in ${shell}. Provision the bundled shell ` +
        `(Settings → General → Shell) or set NOVACLAW_GIT_BASH_PATH; POSIX syntax will fail until then.`,
    )
  }
  return (
    `⚠️ Shell: this host has NO bash — your \`bash\` tool runs \`${shell}\`. POSIX syntax (\`ls\`, ` +
    `pipes, \`2>/dev/null\`, \`VAR=x cmd\`, forward slashes) will FAIL here; use that shell's own ` +
    `syntax, and prefer the native read/edit/write/glob/grep tools over shell commands.`
  )
}

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}
