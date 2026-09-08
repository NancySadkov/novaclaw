/**
 * **Drive the real instance-home resolution with a stringified `undefined`, then LOOK AT THE DISK.**
 *
 * Principle 11's commentary says the `kbmem_*` litter *"survived two rounds of fixes: nothing ever
 * looked"* — every test ran inside the tree, so a file written outside it was invisible. The same
 * class then produced `C:\Users\<u>\undefined\novaclaw`, six days of real databases in a folder named
 * after a JavaScript value, and again nothing looked: the owner found it on their own drive.
 *
 * This fixture is the instrument that looks. `Global.dirs()` and the temp root both memoise ONCE per
 * process, so an in-process test cannot poison them — whichever test ran first has fixed the answer
 * for every other. The parent arranges a sandbox and sets one poison per child; this script imports
 * the real modules in the real order and reports both what they RESOLVED and what actually appeared
 * on the filesystem.
 *
 * ⚠️ **Every run carries its own UNGUARDED TWIN**, in the same process, under the same poison, in a
 * separate sub-directory. "No stray appeared" is trivially true if the poison stopped biting — a
 * scrubbed variable, a Node change, a typo in the parent — and a green test that cannot fail is worse
 * than none. The twin is the pre-fix expression verbatim, and the parent asserts it DID create a
 * directory named `undefined` before believing that the guarded arm did not.
 *
 * Usage: `bun run write-scope-poison.ts <scenario>` with `POISON_SANDBOX` set. One JSON line on
 * stdout; warnings go to stderr.
 */
import os from "node:os"
import fsSync from "node:fs"
import path from "node:path"

const APP = "novaclaw"
const scenario = process.argv[2] ?? ""
const sandbox = process.env["POISON_SANDBOX"]
if (sandbox === undefined || sandbox.trim() === "") throw new Error("POISON_SANDBOX is required")

const home = path.join(sandbox, "home")
const guarded = path.join(sandbox, "guarded")
const unguarded = path.join(sandbox, "unguarded")
const sandboxTmp = path.join(sandbox, "tmp")
for (const dir of [home, guarded, unguarded, sandboxTmp]) fsSync.mkdirSync(dir, { recursive: true })

// Start from a known-clean environment — an outer shell that exports HOME is exactly why this bug
// never reproduced in development.
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "NOVACLAW_HOME",
  "NOVACLAW_TEST_HOME",
  "NOVACLAW_CONFIG_DIR",
  "NOVACLAW_SCRATCH_ROOT",
  "NOVACLAW_DB",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
])
  delete process.env[key]

process.env["HOME"] = home
process.env["USERPROFILE"] = home
// Keep the emergency root and `<tmp>/novaclaw` inside the sandbox so a relocation is still observable
// here rather than in the machine's real temp dir. The `temp-undefined` scenario overrides this.
process.env["TMPDIR"] = sandboxTmp
process.env["TMP"] = sandboxTmp
process.env["TEMP"] = sandboxTmp

let osHome: string | undefined = home
// @ts-expect-error deliberate: the platform half of this bug is os.homedir() answering with nothing.
os.homedir = () => osHome

switch (scenario) {
  // The exact v0.1.0 poison. `Object.assign(process.env, {XDG_DATA_HOME: undefined})` does not skip
  // the key — Node stringifies, so the variable holds the six characters "undefined".
  case "xdg-literal-undefined":
    process.env["XDG_DATA_HOME"] = String(undefined)
    process.env["XDG_CONFIG_HOME"] = String(undefined)
    process.env["XDG_CACHE_HOME"] = String(undefined)
    process.env["XDG_STATE_HOME"] = String(undefined)
    break
  // The platform cause: in Electron's packaged utilityProcess on win32, os.homedir() came back empty
  // and nothing in the environment carried the home either.
  case "empty-homedir":
    osHome = ""
    delete process.env["HOME"]
    delete process.env["USERPROFILE"]
    break
  // The newer knob. `--home`/`NOVACLAW_HOME` did not exist when the original bug shipped, so it is
  // the one a future regression is most likely to arrive through.
  case "novaclaw-home-undefined":
    process.env["NOVACLAW_HOME"] = String(undefined)
    break
  // The hole that was STILL OPEN on 2026-08-18: os.tmpdir() returns TMPDIR/TMP/TEMP verbatim and the
  // temp root was the one instance directory that never went through Xdg.isSuspect.
  case "temp-undefined":
    process.env["TMPDIR"] = String(undefined)
    process.env["TMP"] = String(undefined)
    process.env["TEMP"] = String(undefined)
    // Pin the documented-default fallback inside the sandbox too, so a relocation is observable here
    // and the fixture never writes into the machine's real C:\Windows\Temp.
    process.env["SystemRoot"] = sandbox
    process.env["windir"] = sandbox
    break
  default:
    throw new Error(`unknown scenario ${JSON.stringify(scenario)}`)
}

// ── the UNGUARDED TWIN ───────────────────────────────────────────────────────────────────────────
// The pre-fix expression, run against the same poison, in its own cwd. A relative path resolves
// against the process's working directory — which is precisely why the stray landed in the owner's
// home folder rather than somewhere obviously wrong.
process.chdir(unguarded)
const twinTarget = ((): string => {
  if (scenario === "temp-undefined") return path.join(String(os.tmpdir()), APP) // `const tmp = path.join(os.tmpdir(), app)`
  // The `xdg-basedir` shape: `xdgData = process.env.XDG_DATA_HOME || join(homedir, ".local/share")`,
  // then `path.join(xdgData!, app)`.
  const rawHome = osHome || process.env["USERPROFILE"] || process.env["HOME"]
  const rawData =
    process.env["NOVACLAW_HOME"] ??
    process.env["XDG_DATA_HOME"] ??
    (rawHome ? path.join(rawHome, ".local", "share") : undefined)
  return path.join(String(rawData), APP)
})()
let twinCreated = false
try {
  fsSync.mkdirSync(twinTarget, { recursive: true })
  twinCreated = true
} catch {
  twinCreated = false
}

// ── the GUARDED arm ──────────────────────────────────────────────────────────────────────────────
process.chdir(guarded)
const { Global } = await import("@novaclaw/core/global")
const { Scratch } = await import("@novaclaw/core/scratch")

const resolved: Record<string, string> = {
  data: Global.Path.data,
  cache: Global.Path.cache,
  config: Global.Path.config,
  state: Global.Path.state,
  log: Global.Path.log,
  repos: Global.Path.repos,
  bin: Global.Path.bin,
  tmp: Global.Path.tmp,
  scratch: Scratch.root(),
}
// Not just resolution — the scratch dir is where a folder-less agent's session lands, and creating
// one is what 500'd in v0.1.0. Make the bytes happen.
try {
  await Scratch.ensure()
} catch {
  /* an unwritable fallback is not what this fixture measures; the disk scan below is */
}

/** Every entry named exactly `undefined` or `null`, anywhere under `dir`. */
const straysUnder = (dir: string): string[] => {
  const found: string[] = []
  const walk = (at: string, depth: number) => {
    if (depth > 8) return
    let entries: fsSync.Dirent[]
    try {
      entries = fsSync.readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name)
      if (entry.name === "undefined" || entry.name === "null") found.push(full)
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(dir, 0)
  return found
}

process.stdout.write(
  JSON.stringify({
    scenario,
    twin: { target: twinTarget, created: twinCreated, strays: straysUnder(unguarded) },
    resolved,
    status: Global.directoryStatus(),
    // The guarded arm's whole reachable world: its cwd, the fake home, and the temp root it was given.
    strays: [...straysUnder(guarded), ...straysUnder(home), ...straysUnder(sandboxTmp)],
  }) + "\n",
)
