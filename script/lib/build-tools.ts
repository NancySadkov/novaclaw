// WHICH BINARY the build actually runs, on Windows (owner, 2026-08-23: *"please ensure the build
// uses the w64devkit's tar and other utils on windows, instead of going for c:\windows or the git's
// tar"*).
//
// 🔴 **A bare tool name on Windows is a lottery, and it has already cost a release.** Cutting 0.1.66
// died at the LAST step on `tar: unrecognized option '--options'`: `tar.exe` resolved by PATH, and on
// a machine with Git for Windows installed that is GNU tar, not the bsdtar the script's own comment
// assumed. The app archive had already been produced, so it read as an archiving bug rather than as
// the wrong binary. Three different `tar.exe` are reachable on this box — busybox's, GNU's and
// libarchive's — and they do not agree on flags, on formats, or on what a path separator is.
//
// So this module resolves a build utility by ABSOLUTE PATH, preferring the w64devkit we SHIP, and
// never by `PATH`. Two properties are load-bearing:
//
//  1. **Preference order is explicit**, and the shipped kit is first. What we ship is the version we
//     pinned, hashed and smoke-tested; whatever a developer happens to have installed is not.
//  2. **A candidate is PROBED for the capability, never assumed to have it.** This is the half that
//     would have caught the 0.1.66 failure a year earlier: the previous fix pinned an absolute path
//     from reasoning about which binary lives there, and reasoning is what was wrong the first time.
//     ⚠️ It also settles a real limit honestly — w64devkit's `tar` is **busybox** tar, which cannot
//     write 7z at all. Preferring it blindly would trade one wrong binary for another.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

/** The w64devkit we ship with the desktop app, as laid down by `prepare-w64devkit.ts`. */
export const shippedW64devkitBin = (repoRoot: string): string =>
  path.join(repoRoot, "packages", "desktop", "resources", "third-party", "w64devkit", "bin")

/**
 * Where a Windows build utility may come from, best first.
 *
 * ⚠️ `PATH` is not in this list and must not be added. The entries are directories, and a candidate
 * that does not exist is skipped rather than being an error — a POSIX host has none of them.
 */
export function candidateDirs(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [shippedW64devkitBin(repoRoot)]
  // The developer's own w64devkit, when they have one. Second, because it is not the pinned version.
  const local = env["W64DEVKIT_HOME"]
  if (local) dirs.push(path.join(local, "bin"))
  dirs.push("C:\\soft\\w64devkit\\bin")
  // LAST, and only for a capability no w64devkit binary has. Windows 10+ ships libarchive's bsdtar
  // as `System32\tar.exe`; it is the only 7z WRITER on a stock box.
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"]
  if (systemRoot) dirs.push(path.join(systemRoot, "System32"))
  return dirs
}

export interface ToolProbe {
  /** Arguments that make the tool prove the capability. Exit 0 means it has it. */
  readonly args: readonly string[]
  /** Extra evidence the output must contain, when an exit code alone is not conclusive. */
  readonly expect?: RegExp
}

export interface Resolution {
  /** Absolute path to the binary that PASSED the probe. */
  readonly path: string
  /** Every candidate considered, with why it was rejected. Printed on failure; useful on success. */
  readonly considered: ReadonlyArray<{ readonly path: string; readonly ok: boolean; readonly why: string }>
}

export class ToolNotFoundError extends Error {
  override readonly name = "BuildTools.ToolNotFoundError"
  constructor(
    readonly tool: string,
    readonly considered: Resolution["considered"],
  ) {
    super(
      `no ${tool} on this machine can do what the build needs.\n` +
        considered.map((item) => `  ${item.ok ? "ok  " : "no  "} ${item.path} — ${item.why}`).join("\n") +
        `\nPATH is deliberately not searched: a bare tool name resolves to whichever ${tool} a ` +
        `developer happens to have installed, and that is what broke the 0.1.66 release.`,
    )
  }
}

/** Run a probe. Exported so a test can substitute it and keep the resolver hermetic. */
export type Runner = (file: string, args: readonly string[]) => { status: number | null; output: string }

const defaultRunner: Runner = (file, args) => {
  const result = spawnSync(file, [...args], { encoding: "utf8", windowsHide: true })
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

/**
 * Find the first candidate `name` that passes `probe`.
 *
 * `exists` is injectable for the same reason `run` is: a test must be able to describe a machine
 * other than the one it is running on, and the failure path is the one worth testing.
 */
export function resolveTool(input: {
  readonly name: string
  readonly repoRoot: string
  readonly probe: ToolProbe
  readonly env?: NodeJS.ProcessEnv
  readonly run?: Runner
  readonly exists?: (file: string) => boolean
}): Resolution {
  const run = input.run ?? defaultRunner
  const exists = input.exists ?? ((file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true)
  const considered: Array<{ path: string; ok: boolean; why: string }> = []

  for (const dir of candidateDirs(input.repoRoot, input.env)) {
    const file = path.join(dir, input.name)
    if (!exists(file)) {
      considered.push({ path: file, ok: false, why: "not present" })
      continue
    }
    let result: { status: number | null; output: string }
    try {
      result = run(file, input.probe.args)
    } catch (error) {
      considered.push({ path: file, ok: false, why: `probe threw: ${String(error)}` })
      continue
    }
    if (result.status !== 0) {
      considered.push({ path: file, ok: false, why: `probe exited ${result.status ?? "null"}` })
      continue
    }
    if (input.probe.expect && !input.probe.expect.test(result.output)) {
      considered.push({ path: file, ok: false, why: `probe output did not match ${String(input.probe.expect)}` })
      continue
    }
    considered.push({ path: file, ok: true, why: "probe passed" })
    return { path: file, considered }
  }
  throw new ToolNotFoundError(input.name, considered)
}

/**
 * The archiver that can rewrite a `.tar` into a `.7z` — i.e. a libarchive `tar` whose `--options`
 * understands the 7zip writer.
 *
 * ⚠️ **w64devkit's `tar` cannot do this and is expected to fail the probe.** It is busybox tar: no
 * `--options`, no 7z writer. That is not a reason to skip the preference order — the order is what
 * makes the fallback a MEASURED last resort instead of an assumption — but it does mean this
 * particular capability lands on Windows' own bsdtar, and saying so here is cheaper than someone
 * rediscovering it during a release.
 */
export function resolveSevenZipArchiver(repoRoot: string, options?: { env?: NodeJS.ProcessEnv; run?: Runner }) {
  return resolveTool({
    name: "tar.exe",
    repoRoot,
    // `--options` on an empty format list is a no-op for libarchive and an "unrecognized option"
    // for GNU and busybox tar — which is exactly the discrimination the build needs.
    probe: { args: ["--version"], expect: /bsdtar|libarchive/i },
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.run ? { run: options.run } : {}),
  })
}
