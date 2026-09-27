#!/usr/bin/env bun

/**
 * 🔴 THIS IS A GATE, NOT A BUILD STEP. It boots what `build-node.ts` compiled and asks it things.
 *
 * It used to live at the end of the build, and that was wrong in a way that only showed up once a
 * feature could legitimately be OFF. Measured 2026-09-27: the 0.1.80 zip build failed at
 * `script "prebuild" exited with code 1` with
 *
 *   node-sidecar-smoke: memory list answered 400: memory worker timed out in list
 *
 * and the cause was not a broken bundle. Memory had just become OPT-IN (`memory-setting.ts`), so a
 * fresh instance no longer opens the graph engine at boot; the smoke's `world-memory.list` became
 * the FIRST cold call, and a cold call pays `WasmMemory.open` — a fixed ~1.3 GB arena, measured
 * today at 419 MB for an empty store — inside the capability's 30 s deadline. The build could not
 * compile a byte because a runtime feature was in a state the user had legitimately chosen.
 *
 * A build that boots the product is a build whose success depends on things a build does not
 * control: a model provider, a Wasm arena, a clock, a machine with spare memory. Every one of those
 * is a legitimate state, and none of them is a compile error. `AGENTS.md` already said an RC build
 * "runs no tests, smoke, source/SBOM"; the code had drifted from the rule and the drift was invisible
 * because the smoke passed while memory was on by default.
 *
 * ⚠️ WHAT MUST NOT HAPPEN HERE: do not "fix" this by deleting these two smokes. `splitting: true` in
 * `build-node.ts` exists BECAUSE a smoke boots the split bundle and exercises it — the comment there
 * says so and says not to copy the flag to the binary build without an equivalent check. With the
 * smoke off the build path, this script is the only thing standing between a chunk-ordering defect
 * and a release, and that defect is invisible to the unit suite by construction: split chunks can
 * evaluate circular LayerNode imports in a different order than the source graph and only fail after
 * the first HTTP request.
 *
 * Run it: `bun run verify:sidecar` from `packages/novaclaw`, after `bun run build`.
 */

import { mkdtemp, rm } from "node:fs/promises"
import path from "path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

/**
 * ⚠️ Skipped LOUDLY rather than silently when there is no `node` on PATH. A skipped check that says
 * nothing is indistinguishable from a passing one, and this is the only thing standing between a
 * chunk-ordering defect and a release.
 */
const nodeExe = Bun.which("node")
if (!nodeExe) {
  console.warn("WARNING: no `node` on PATH — SKIPPING the sidecar boot smoke. The split bundle is UNVERIFIED.")
  process.exit(0)
}

// Its own XDG roots and its own database: the smoke boots a real server, and a server pointed at
// the developer's actual data would write to it.
/**
 * 🔴 **RETRY A WEDGE, FAIL A DEFECT — and never block forever on either.**
 *
 * `Bun.spawnSync` blocks until the child exits, so before the smoke grew its own deadline a boot
 * that never finished did not fail this build, it STOPPED it: the log ended mid-line, no error was
 * written, and the only symptom was a process at 0 % CPU. It cost three builds and about
 * forty-five minutes in one evening (2026-08-27/28), each time clearing on a plain re-run.
 *
 * So the two outcomes are now separated, because they deserve opposite treatment:
 *   · **exit 3 — the smoke timed out.** It wedged; it did not learn anything about the bundle.
 *     Every observed instance passed on the next attempt, so retry once rather than making a person
 *     do it. A second timeout is reported as itself, not disguised as a bundle defect.
 *   · **any other non-zero — the bundle does not serve.** That is the defect this check exists to
 *     catch, and it fails immediately. A retry here would be a loop that hides a real fault, which is
 *     the opposite of the point.
 *
 * ⚠️ A FRESH home per attempt. The smoke boots a real server against real XDG roots, and handing a
 * retry the directories a wedged attempt left behind would make the retry the least trustworthy run
 * of the two.
 */
const runSmoke = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "novaclaw-sidecar-smoke-"))
  // 🔴 BUILD the child's environment; do not hand it ours wholesale.
  //
  // A launch credential is argv-or-settings, never environment (`server-launch-credential.ts`), and
  // `warnOnIgnoredEnv` announces the variable when it is present — so an exported
  // NOVACLAW_SERVER_PASSWORD changes nothing about what this smoke server accepts. It is stripped
  // anyway for two reasons that are not about behaviour:
  //   · it otherwise travels into a spawned process that can never use it, where anything able to
  //     read that process can read it. The owner's shell exports a real one.
  //   · it makes the smoke print "set in this shell and is IGNORED" into build output nobody asked
  //     for, in the one place a person is reading the log closely.
  // Nothing here needs it: the smoke authenticates with its own `smoke-${random}` credential, and an
  // explicit credential always outranks the env fallback (`server/src/auth.ts` `headerFrom`).
  // ⚠️ The annotation is load-bearing, not decoration: spreading `process.env` into a literal drops
  // its index signature (the inferred type keeps only the keys TypeScript has heard of), and the two
  // `delete`s below then fail to compile — which is the typechecker pointing at the one property
  // this block is actually about.
  const env: Record<string, string | undefined> = {
    ...process.env,
    NOVACLAW_DB: ":memory:",
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    NODE_PATH: path.resolve(dir, "../desktop/node_modules"),
  }
  delete env.NOVACLAW_SERVER_PASSWORD
  delete env.NOVACLAW_SERVER_USERNAME
  try {
    return Bun.spawnSync(
      [nodeExe, "--experimental-sqlite", "./script/node-sidecar-smoke.mjs", "./dist/node/node.js"],
      { stdout: "inherit", stderr: "inherit", env },
    ).exitCode
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const SMOKE_WEDGED = 3
let code = await runSmoke()
if (code === SMOKE_WEDGED) {
  console.warn("Node sidecar smoke WEDGED (timed out) — retrying once on a fresh home.")
  code = await runSmoke()
}
if (code === SMOKE_WEDGED)
  throw new Error(
    "Node sidecar smoke timed out twice — the step is wedging, not the bundle failing. " +
      "Run `node script/node-sidecar-smoke.mjs ./dist/node/node.js` directly to see where it stops.",
  )
if (code !== 0) throw new Error("Node sidecar smoke failed — the built bundle does not serve")

const memoryWorker = Bun.spawnSync(
  [nodeExe, "./script/memory-worker-smoke.mjs", "./dist/node/memory-worker-node.js"],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env, NODE_PATH: path.resolve(dir, "../desktop/node_modules") } },
)
if (memoryWorker.exitCode !== 0) throw new Error("Node memory worker smoke failed")

console.log("Sidecar verification complete")
