export * as Shell from "./shell"

import path from "path"
import { readFile } from "fs/promises"
import { readFileSync, statSync } from "fs"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { ShellBundle } from "./shell-bundle"
import { which } from "./util/which"

/**
 * **The one tree-kill in the codebase**, re-exported here under its established name.
 *
 * The implementation lives in `./util/kill-tree` — a LEAF module that imports nothing but `node:`
 * builtins — because the jh engine is one of its callers and `src/jh/imports.test.ts` (§0.7.2)
 * forbids jh from importing anything that reaches the config/service tree, which this file does
 * (`Flag`, `FSUtil`, `ShellBundle`, `which` → `Global`). `Shell.killTree` and the leaf module are
 * the SAME function; import whichever spelling is cheaper where you stand.
 *
 * ⚠️ Do not hand-roll another one. `test/kill-tree-ledger.test.ts` fails the build if you do.
 */
export { SIGKILL_TIMEOUT_MS, descendantsOf, killTree, killTreeSync } from "./util/kill-tree"
export type { KillTreeOptions, KillTreeTarget } from "./util/kill-tree"

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
      [w64devkitShell(), gitbash(), which("pwsh"), which("powershell"), process.env.COMSPEC || "cmd.exe"]
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

/** The Windows distribution's embedded POSIX shell. Unlike the retired PortableGit-only model,
 *  w64devkit is part of every packaged Windows build and also supplies GCC/binutils. The desktop
 *  launcher provides the resource root; source/dev runs may opt into an extracted kit explicitly. */
export function w64devkitRoot() {
  if (process.platform !== "win32") return
  const root = Flag.NOVACLAW_W64DEVKIT_PATH
  if (!root) return
  const shell = path.join(root, "bin", "sh.exe")
  const gcc = path.join(root, "bin", "gcc.exe")
  if (stat(shell)?.isFile() && stat(gcc)?.isFile()) return root
}

export function w64devkitShell() {
  const root = w64devkitRoot()
  return root ? path.join(root, "bin", "sh.exe") : undefined
}

/** Functional child environment for the composed Windows toolchain. w64devkit's own shell needs
 *  its bin first; Git Bash keeps its MSYS userland first and receives w64devkit last so GCC is
 *  available without recreating the measured BusyBox-shadowing failure. */
export function toolchainEnv(file: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (process.platform !== "win32") return
  const root = w64devkitRoot()
  const key = Object.keys(base).find((item) => item.toLowerCase() === "path") ?? "PATH"
  const existing = base[key]
  const bin = root ? path.join(root, "bin") : undefined
  const inKit = root
    ? FSUtil.windowsPath(file)
        .toLowerCase()
        .startsWith(`${FSUtil.windowsPath(root).toLowerCase()}\\`)
    : false
  const paths = inKit
    ? [bin, existing]
    : name(file) === "bash"
      ? [...ShellBundle.pathPrepend(file), existing, bin]
      : [existing, bin]
  const value = Array.from(new Set(paths.filter((item): item is string => Boolean(item)))).join(path.delimiter)
  if (!value) return
  return {
    [key]: value,
    ...(root ? { W64DEVKIT_HOME: root, W64DEVKIT: readVersion(root) } : {}),
  }
}

function readVersion(root: string) {
  try {
    return statSync(path.join(root, "VERSION.txt"), { throwIfNoEntry: false })?.isFile()
      ? readFileSync(path.join(root, "VERSION.txt"), "utf8").trim()
      : "embedded"
  } catch {
    return "embedded"
  }
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
    if (process.platform === "win32") return w64devkitShell() ?? gitbash() ?? process.env.COMSPEC ?? "cmd.exe"
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
 * TRUE when the agent shell accepts POSIX syntax. The embedded w64devkit shell is BusyBox ash,
 * deliberately not Bash, but it supports the command language agents need. A silent cmd fallback
 * is the expensive failure: the
 * model writes POSIX, cmd.exe answers, and the task dies of unrelated-looking errors. Callers that
 * hand the shell to a model surface this instead of guessing (`shellFallbackNote`), and the first
 * call also logs it once for the server operator.
 */
export function agentShellIsPosix(): boolean {
  return posix(agentDefault())
}

/** One line for the agent's system prompt when its shell is not POSIX-compatible, else undefined. */
export function shellFallbackNote(): string | undefined {
  if (agentShellIsPosix()) return undefined
  const shell = agentDefault()
  if (!warnedFallback) {
    warnedFallback = true
    console.warn(
      `[shell] no POSIX shell found — agent commands will run in ${shell}. Repair the bundled shell ` +
        `(Settings → General → Shell) or set NOVACLAW_GIT_BASH_PATH; POSIX syntax will fail until then.`,
    )
  }
  return (
    `⚠️ Shell: this host has NO POSIX shell — your \`bash\` tool runs \`${shell}\`. POSIX syntax (\`ls\`, ` +
    `pipes, \`2>/dev/null\`, \`VAR=x cmd\`, forward slashes) will FAIL here; use that shell's own ` +
    `syntax, and prefer the native read/edit/write/glob/grep tools over shell commands.`
  )
}

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??=
    process.platform === "win32" ? (w64devkitShell() ?? select(process.env.SHELL)) : select(process.env.SHELL)
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
