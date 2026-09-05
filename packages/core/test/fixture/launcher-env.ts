import path from "path"

/**
 * 🔴 **A test suite launched from inside a running NovaClaw was testing that installation, not the
 * source tree.**
 *
 * `bun run test` spawns its units as children, and a child inherits its parent's whole environment. When
 * the parent is a `bash` tool call from a live desktop instance, that environment carries the launcher's
 * own description of the install it started — `packages/desktop/src/main/server.ts` sets
 * `NOVACLAW_RIPGREP_PATH`, `NOVACLAW_W64DEVKIT_PATH`, `NOVACLAW_IMAGEMAGICK_PATH`, `NOVACLAW_CLIENT`, and
 * two `NOVACLAW_EXPERIMENTAL_*` switches. Those variables are not developer intent. They are the running
 * product telling its own children where its bundled binaries live.
 *
 * The consequence, measured 2026-09-04 on a clean `main`: nine `core` tests failed, and every one of
 * them failed because the code under test correctly answered a question about *this machine's install*
 * while the assertion described a bare checkout.
 *
 *  · `preferred()` is `w64devkitShell() ?? select($SHELL)` — bundle-first, by B11 design. Four
 *    `shell.test.ts` cases set `$SHELL` and expected it to win; with the bundle variable inherited it
 *    cannot. They passed on a machine with no bundle and failed on one with a bundle.
 *  · `builtins.ts` advertises `magick` in `<env>` only when `Shell.imagemagick()` resolves. Three
 *    `system-context/builtins.test.ts` golden strings therefore gained seven lines on an install that
 *    ships ImageMagick.
 *  · `shell-bundle.test.ts` asserted `w64devkit/bin` is LAST on PATH; ImageMagick is appended after it,
 *    so the assertion held only where ImageMagick is absent.
 *  · `Flag.NOVACLAW_CLIENT` is `env(...) ?? "cli"`, and `models-dev.ts` puts it in the User-Agent. With
 *    `NOVACLAW_CLIENT=desktop` inherited, `models.test.ts` read `…/desktop` where it expects `…/cli`.
 *
 * None of those four is a code defect — each is the correct answer to a different machine. The defect is
 * that the suite could be asked two questions at once, which is why a green run proved nothing about the
 * commit it was run on. `test/launcher-env.test.ts` is the ratchet on that shape.
 *
 * ⚠️ **What is deliberately NOT scrubbed**: `NOVACLAW_DB`, `NOVACLAW_HOME`, `NOVACLAW_MODELS_PATH`,
 * `NOVACLAW_DISABLE_MODELS_FETCH` and `NOVACLAW_DEV_ISOLATED`. Those are the developer's or the runner's
 * isolation knobs — intent, not install shape — and `preload.ts` sets three of them itself immediately
 * after calling this.
 */
export const LAUNCHER_ENV_SCRUB = [
  "NOVACLAW_RIPGREP_PATH",
  "NOVACLAW_W64DEVKIT_PATH",
  "NOVACLAW_IMAGEMAGICK_PATH",
  "NOVACLAW_GIT_BASH_PATH",
  "NOVACLAW_CLIENT",
  "NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY",
  "NOVACLAW_EXPERIMENTAL_FILEWATCHER",
  "NOVACLAW_DISABLE_CHANNEL_DB",
  // Side effects of an injected ImageMagick, set by `shell.ts` → `toolchainEnv` rather than by the
  // launcher, and equally descriptive of the install rather than of the test.
  "MAGICK_HOME",
  "MAGICK_CONFIGURE_PATH",
] as const

/** Delete the launcher's install-shape variables, so a run answers for the source tree it is standing in. */
export function scrubLauncherEnv(env: NodeJS.ProcessEnv = process.env) {
  const removed: string[] = []
  for (const name of LAUNCHER_ENV_SCRUB) {
    if (name in env) {
      delete env[name]
      removed.push(name)
    }
  }
  return removed
}

/** The names `packages/desktop/src/main/server.ts` injects into every child it launches. */
export function launcherInjectedNames(serverTsSource: string): string[] {
  const names = new Set<string>()
  // Two injection shapes and only these: an object-literal entry (`NOVACLAW_CLIENT: "desktop"`) and a
  // dotted assignment (`env.NOVACLAW_RIPGREP_PATH = …`). A plain read of `process.env.X` is NOT an
  // injection, which is what keeps `NOVACLAW_DEV_ISOLATED` — read, never set, by the launcher — out.
  for (const match of serverTsSource.matchAll(/^\s*(?:[\w.]+\.)?(NOVACLAW_[A-Z0-9_]+)\s*[:=](?!=)/gm)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/** Where the launcher lives, relative to this fixture. Resolved upward so it does not depend on cwd. */
export const DESKTOP_SERVER_TS = path.join(import.meta.dir, "..", "..", "..", "desktop", "src", "main", "server.ts")
