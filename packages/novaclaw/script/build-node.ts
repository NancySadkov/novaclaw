#!/usr/bin/env bun

import { Script } from "@novaclaw/script"
import { mkdtemp, rm } from "node:fs/promises"
import path from "path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// Bun's split build does not remove chunks that disappeared from the current graph. Shipping the
// whole directory would otherwise retain code from an older build, including dependencies that
// have been removed from source. Recreate the output boundary before every sidecar build.
await rm("./dist/node", { recursive: true, force: true })

const result = await Bun.build({
  target: "node",
  // Resolve the core's conditional `#sqlite`/`#pty`/`#fff` imports (package.json `imports`) to
  // their NODE variants. Without this, Bun.build applies its own `bun` condition even under
  // `target: "node"`, so the bundle pulls in `sqlite.bun.ts` (→ `bun:sqlite`) etc. — which the
  // Electron utilityProcess sidecar (plain Node) can't load (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  conditions: ["node"],
  // Dynamic imports become REAL chunks instead of being inlined into one 23 MB file. Measured on the
  // packaged desktop: the entry drops 23.7 MB -> 0.77 MB and `await import()` of it 710 -> 561 ms
  // (n=5, non-overlapping ranges), with `Server.listen` unchanged at ~184 ms — so the work is
  // genuinely deferred rather than moved. That is ~150 ms off every desktop boot.
  //
  // ⚠️ `script/build.ts` sets `splitting: false` for the compiled BINARY, and its reason still holds:
  // split chunks can evaluate circular LayerNode imports in a different order than the source graph,
  // leaving a dependency undefined only AFTER the first HTTP request. It is enabled here — and only
  // here — because `node-sidecar-smoke.mjs` below boots this bundle and makes real requests on every
  // build. Do NOT copy this flag to the binary build without carrying an equivalent check with it.
  splitting: true,
  entrypoints: ["./src/node.ts", "./src/session-worker-node.ts"],
  outdir: "./dist/node",
  format: "esm",
  // Production ships scrubbed crash diagnostics and does not consume this 40 MB map. Generating it
  // was also the sidecar build's largest avoidable memory spike on 16 GB machines; keep maps for
  // dev/beta debugging, but do not spend that RAM or disk in the user-facing release artifact.
  sourcemap: Script.channel === "prod" ? "none" : "linked",
  // `@mtcute/bun` is the Bun-only Telegram-user driver dep (it imports `bun:sqlite`). The driver
  // loads it by DYNAMIC import behind a `typeof Bun` guard, so under Node it's never reached — but
  // Bun.build would otherwise INLINE it into this bundle and hoist its `bun:sqlite` import to the
  // top, breaking the Node sidecar at load. Keep it external so the lazy import stays lazy.
  // jsonc-parser's Node entry is UMD and cannot be safely inlined by Bun (its relative requires are
  // preserved). The desktop package therefore declares it alongside node-pty as an explicit runtime
  // dependency of the opaque sidecar, rather than relying on Electron's old accidental rebundle.
  external: ["jsonc-parser", "@lydell/node-pty", "@mtcute/bun"],
  define: {
    NOVACLAW_MODELS_DEV: generated.modelsData,
    NOVACLAW_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "novaclaw-web-ui.gen.ts": "",
  },
})

// The build result was previously DISCARDED, so a failed sidecar build printed "Build complete" and
// left the previous (or no) bundle in place. Found by an outside contributor reconstructing this file
// from scratch, because the published source was missing it entirely — see .gitignore.
if (!result.success) throw new AggregateError(result.logs, "Node sidecar build failed")
if (Script.channel === "prod")
  await Promise.all([
    rm("./dist/node/node.js.map", { force: true }),
    rm("./dist/node/session-worker-node.js.map", { force: true }),
  ])

// The two comments above say WHY `conditions` and `external` are set the way they are. This turns
// that knowledge into a CHECK: if either regresses, a `bun:` import reaches the bundle and the
// Electron sidecar dies at load with ERR_UNSUPPORTED_ESM_URL_SCHEME — a packaged-only failure a
// green suite cannot see, which is the exact class that shipped v0.0.1 and v0.1.0 broken.
for (const name of ["node.js", "session-worker-node.js"]) {
  const bundled = await Bun.file(`./dist/node/${name}`).text()
  if (/\b(?:from|import\(|require\()\s*["']bun:/.test(bundled))
    throw new Error(`${name} contains a \`bun:\` runtime import — check \`conditions: ['node']\` and the external list`)
}

/**
 * Boot the bundle and ask it things — see `node-sidecar-smoke.mjs` for why a build-time HTTP check is
 * the price of `splitting: true`.
 *
 * ⚠️ Skipped LOUDLY rather than silently when there is no `node` on PATH. A skipped check that says
 * nothing is indistinguishable from a passing one, and this is the only thing standing between a
 * chunk-ordering defect and a release.
 */
const nodeExe = Bun.which("node")
if (!nodeExe) {
  console.warn("WARNING: no `node` on PATH — SKIPPING the sidecar boot smoke. The split bundle is UNVERIFIED.")
} else {
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
   *     catch, and it fails the build immediately. A retry here would be a loop that hides a real
   *     fault, which is the opposite of the point.
   *
   * ⚠️ A FRESH home per attempt. The smoke boots a real server against real XDG roots, and handing a
   * retry the directories a wedged attempt left behind would make the retry the least trustworthy run
   * of the two.
   */
  const runSmoke = async () => {
    const home = await mkdtemp(path.join(tmpdir(), "novaclaw-sidecar-smoke-"))
    try {
      return Bun.spawnSync(
        [nodeExe, "--experimental-sqlite", "./script/node-sidecar-smoke.mjs", "./dist/node/node.js"],
        {
          stdout: "inherit",
          stderr: "inherit",
          env: {
            ...process.env,
            NOVACLAW_DB: ":memory:",
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_CONFIG_HOME: path.join(home, "config"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            XDG_STATE_HOME: path.join(home, "state"),
          },
        },
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
}

console.log("Build complete")
