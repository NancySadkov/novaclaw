/**
 * B11 — the bundled shell substrate (Windows).
 *
 * Agents standardize on bash + git: small models are trained overwhelmingly on bash, and
 * git is the revert substrate (per-turn snapshot trees ride it). PortableGit
 * (git-for-windows) is the ONE bundle: MSYS2 bash + a unix userland + git in a single
 * self-extracting artifact. w64devkit was rejected (no git); MinGit (no usable bash).
 * POSIX hosts use the system bash/git — provisioning is a Windows concern.
 *
 * Provisioning downloads the pinned artifact into <data>/shell and extracts it to
 * <data>/shell/portable-git. It is a provision-BEFORE-airgap operation: in offline mode
 * the download fails closed (same OFF-B pattern as npm installs) unless the URL's host is
 * allowlisted (e.g. a LAN mirror via NOVACLAW_OFFLINE_ALLOW).
 */
export * as ShellBundle from "./shell-bundle"

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"
import { checkUrl, loadPolicy } from "./offline"

export const DEFAULT_VERSION = "2.55.0.2"
export const DEFAULT_URL = `https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.2/PortableGit-${DEFAULT_VERSION}-64-bit.7z.exe`
// Published in the git-for-windows v2.55.0.windows.2 release notes.
export const DEFAULT_SHA256 = "b20d42da3afa228e9fa6174480de820282667e799440d655e308f700dfa0d0df"

const MANIFEST_NAME = "bundle.json"

export interface Manifest {
  readonly kind: "portable-git"
  readonly version: string
  readonly url: string
  readonly sha256: string
  readonly provisionedAt: number
}

export interface Resolved {
  readonly root: string
  readonly bash: string
  readonly git: string
  readonly version?: string
  readonly provisionedAt?: number
}

export class ProvisionError extends Error {
  override readonly name = "ShellBundle.ProvisionError"
}

/** Bundle root. The env override exists for tests and non-standard layouts. */
export function root(): string {
  return process.env.NOVACLAW_SHELL_BUNDLE_ROOT ?? path.join(Global.Path.data, "shell", "portable-git")
}

function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

function isDir(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true
}

function readManifest(dir: string): Manifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8")) as Manifest
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

function probe(): Resolved | undefined {
  // Real resolution is Windows-only; the env override keeps the probe testable anywhere.
  if (process.platform !== "win32" && !process.env.NOVACLAW_SHELL_BUNDLE_ROOT) return undefined
  const dir = root()
  const bash = path.join(dir, "bin", "bash.exe")
  const git = path.join(dir, "cmd", "git.exe")
  if (!isFile(bash) || !isFile(git)) return undefined
  const manifest = readManifest(dir)
  return { root: dir, bash, git, version: manifest?.version, provisionedAt: manifest?.provisionedAt }
}

let cached: Resolved | null | undefined
/** The provisioned bundle, or undefined. Cached per process (reset after provisioning). */
export function resolve(): Resolved | undefined {
  if (cached === undefined) cached = probe() ?? null
  return cached ?? undefined
}
resolve.reset = () => {
  cached = undefined
}

/**
 * The MSYS root of a bash at `<root>/bin/bash.exe` or `<root>/usr/bin/bash.exe` —
 * works for the bundle AND a system git-for-windows install.
 */
export function msysRoot(bashPath: string): string | undefined {
  const dir = path.dirname(bashPath)
  if (path.basename(dir).toLowerCase() !== "bin") return undefined
  const parent = path.dirname(dir)
  return path.basename(parent).toLowerCase() === "usr" ? path.dirname(parent) : parent
}

/** Directories to prepend to PATH so commands under an MSYS bash see git + the userland. */
export function pathPrepend(bashPath: string): string[] {
  const base = msysRoot(bashPath)
  if (!base) return []
  return [
    path.join(base, "mingw64", "bin"),
    path.join(base, "usr", "bin"),
    path.join(base, "cmd"),
    path.join(base, "bin"),
  ].filter(isDir)
}

/**
 * An env fragment (`{ PATH }`, keyed with the platform's actual casing) that puts the
 * bash's own userland first — `bash -c` is NOT a login shell, so /etc/profile never runs
 * and without this the child PATH lacks git/coreutils on a machine that has neither.
 */
export function envForBash(
  bashPath: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const prepend = pathPrepend(bashPath)
  if (prepend.length === 0) return undefined
  const key = Object.keys(base).find((name) => name.toLowerCase() === "path") ?? "PATH"
  const existing = base[key]
  return { [key]: [...prepend, ...(existing ? [existing] : [])].join(path.delimiter) }
}

function versionFromUrl(url: string): string | undefined {
  return /PortableGit-([\d.]+)-/.exec(url)?.[1]
}

function defaultExtract(artifact: string, dest: string): Promise<void> {
  // The artifact is a 7-Zip SFX: running it with -y -o<dir> extracts silently.
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(artifact, ["-y", `-o${dest}`], { stdio: "ignore", windowsHide: true })
    child.once("error", (error) => rejectPromise(new ProvisionError(`extractor failed to start: ${error.message}`)))
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new ProvisionError(`extractor exited with code ${code}`)),
    )
  })
}

export interface ProvisionOptions {
  readonly url?: string
  readonly sha256?: string
  readonly configDir?: string
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly extract?: (artifact: string, dest: string) => Promise<void>
  readonly platform?: NodeJS.Platform
}

/** Download + verify + extract the bundle. Fails closed in offline mode (OFF pattern). */
export async function provision(options: ProvisionOptions = {}): Promise<Resolved> {
  const platform = options.platform ?? process.platform
  if (platform !== "win32")
    throw new ProvisionError(
      "bundled-shell provisioning is Windows-only — POSIX hosts already have a system bash; install git with the OS package manager.",
    )
  const url = options.url ?? process.env.NOVACLAW_SHELL_BUNDLE_URL ?? DEFAULT_URL
  const sha256 =
    options.sha256 ?? process.env.NOVACLAW_SHELL_BUNDLE_SHA256 ?? (url === DEFAULT_URL ? DEFAULT_SHA256 : undefined)

  const policy = loadPolicy({ configDir: options.configDir ?? Global.Path.config, env: options.env })
  const verdict = checkUrl(url, policy)
  if (!verdict.allowed)
    throw new ProvisionError(
      `provision-before-airgap: the shell bundle must be downloaded while online. ${verdict.message}`,
    )

  const dest = root()
  const downloadDir = path.dirname(dest)
  await fsp.mkdir(downloadDir, { recursive: true })
  const artifact = path.join(downloadDir, "portable-git-download.7z.exe")

  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url)
  if (!response.ok || !response.body)
    throw new ProvisionError(`download failed: HTTP ${response.status} for ${url}`)
  const hash = createHash("sha256")
  const handle = await fsp.open(artifact, "w")
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk)
      hash.update(buffer)
      await handle.write(buffer)
    }
  } finally {
    await handle.close()
  }
  const digest = hash.digest("hex")
  if (sha256 && digest.toLowerCase() !== sha256.toLowerCase()) {
    await fsp.rm(artifact, { force: true })
    throw new ProvisionError(`sha256 mismatch for ${url}: expected ${sha256}, got ${digest} — refusing to extract.`)
  }

  await fsp.rm(dest, { recursive: true, force: true })
  await (options.extract ?? defaultExtract)(artifact, dest)
  await fsp.rm(artifact, { force: true })

  resolve.reset()
  const resolved = probe()
  if (!resolved)
    throw new ProvisionError(
      "extraction completed but bin/bash.exe + cmd/git.exe were not found — unexpected artifact layout.",
    )
  const manifest: Manifest = {
    kind: "portable-git",
    version: versionFromUrl(url) ?? "unknown",
    url,
    sha256: digest,
    provisionedAt: Date.now(),
  }
  await fsp.writeFile(path.join(dest, MANIFEST_NAME), JSON.stringify(manifest, null, 2))
  resolve.reset()
  return resolve()!
}
