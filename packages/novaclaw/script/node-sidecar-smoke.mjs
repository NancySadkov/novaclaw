/**
 * Boot the Node sidecar bundle and actually ASK it things.
 *
 * 🔴 THE REASON THIS EXISTS. The bundle is built with `splitting: true`, which is what makes its
 * dynamic imports genuinely lazy — worth ~150 ms of every desktop boot. But `script/build.ts` sets
 * `splitting: false` for the compiled binary with a warning that has teeth: *Bun's split chunks can
 * evaluate circular LayerNode imports in a different order than the source graph, leaving a
 * dependency undefined — and only AFTER the first HTTP request.* A bundle with that defect BUILDS
 * clean, LOADS clean, and passes `--version`. The repository test suite cannot see it either, because
 * the suite runs against SOURCE and this is a property of the emitted chunks.
 *
 * So the split is allowed only because this runs on every build: boot the real bundle under real
 * Node, and make real requests across DIFFERENT parts of the layer graph. An ordering defect is an
 * exception or a 5xx here, at build time, instead of a white screen in somebody's release.
 *
 * Both arms were proven to bite before this was trusted: a bundle poisoned to throw at load exits 1,
 * and an unreachable probe path reports a failed endpoint.
 *
 * ⚠️ Run under NODE, never Bun. The bundle is built with `conditions: ["node"]` and the runtime it
 * has to survive is Electron's utility process; smoking it under the build's own Bun would exercise
 * a graph the product never loads.
 */

import { pathToFileURL } from "node:url"
import path from "node:path"

/**
 * 🔴 **A DEADLINE, because this step hung three release builds in one evening.**
 *
 * `build-node.ts` runs this through `Bun.spawnSync`, which blocks until the child exits. So a boot
 * that never finishes does not fail the build — it STOPS it, with the log ending mid-line and no
 * error anywhere. Measured 2026-08-27/28: three separate builds wedged here, each confirmed by 0 s of
 * CPU across a 20 s window with commit charge frozen to the byte, one of them sitting for 24 minutes
 * before anyone looked. The boot takes ~2 s when it works, and passes standalone every time.
 *
 * ⚠️ The cause is still unknown and this does not claim to fix it. What it fixes is the FAILURE MODE:
 * an unbounded hang becomes a named, bounded failure a caller can see, report and retry. That is the
 * rule the repo already applies to `bun test` — "bare `bun test <directory>` has no wall-clock kill" —
 * which the release path simply never got.
 *
 * Exit 3 is reserved for this, so the caller can tell "wedged" from "the bundle does not serve" and
 * retry only the former. 90 s is generous on purpose: long enough that a cold, loaded machine is
 * never blamed, short enough that a wedge costs a minute rather than an evening.
 */
const DEADLINE_MS = Number(process.env.NOVACLAW_SMOKE_TIMEOUT_MS ?? 90_000)
const deadline = setTimeout(() => {
  console.error(
    `node-sidecar-smoke: TIMED OUT after ${DEADLINE_MS} ms — the bundle never finished serving. This ` +
      "does not prove the artifact is bad; the step wedged. Retry, and if it repeats, run " +
      "`node script/node-sidecar-smoke.mjs ./dist/node/node.js` directly to see where it stops.",
  )
  process.exit(3)
}, DEADLINE_MS)
// Never hold the process open on our own account: if the smoke finishes first, this must not be the
// thing keeping Node alive.
deadline.unref?.()

const bundle = process.argv[2]
if (!bundle) {
  console.error("node-sidecar-smoke: pass the bundle path")
  process.exit(2)
}

// ⚠️ A file URL, not the bare argument. A relative specifier passed to `import()` resolves against
// THIS module rather than the working directory, so `./dist/node/node.js` became
// `script/dist/node/node.js` and the smoke failed with a resolution error that looked like a broken
// bundle — the check crying wolf about the thing it exists to protect.
const { Server } = await import(pathToFileURL(path.resolve(bundle)).href)

const password = `smoke-${Math.random().toString(36).slice(2)}`
const listener = await Server.listen({
  port: 0,
  hostname: "127.0.0.1",
  username: "novaclaw",
  password,
  cors: ["nc://renderer"],
})
const port = listener.port ?? listener.address?.port
const auth = "Basic " + Buffer.from(`novaclaw:${password}`).toString("base64")

/**
 * Chosen to reach DIFFERENT subsystems, not to be a long list: the hazard is about evaluation ORDER,
 * so one endpoint — however deep — proves almost nothing. Health is the layer graph, capability the
 * subsystem registry, config the store graph, and agent list the location-scoped catalogue.
 */
const paths = [
  // ⚠️ A VERIFICATION KNOB, kept deliberately. A guard nobody has ever seen fail is not known to be a
  // guard, and this one protects a defect class that builds and loads clean. Set
  // `NOVACLAW_SMOKE_POISON_PATH` to something that must fail (e.g. `http://127.0.0.1:1/nope`) and the
  // run has to go red. It can only ADD a probe, so it cannot loosen the check.
  ...(process.env.NOVACLAW_SMOKE_POISON_PATH ? [process.env.NOVACLAW_SMOKE_POISON_PATH] : []),
  "/global/health",
  "/global/config",
  "/api/capability",
  "/api/agent",
  "/config",
  "/agent",
]

let failures = 0
for (const path of paths) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: auth } })
    // ⚠️ 5xx and THROWN are the failures. A 404 is a route that moved, which this file is not the
    // right place to police — asserting exact routes here would turn every API change into a
    // mysterious build break far from its cause.
    if (response.status >= 500) {
      failures += 1
      console.error(`node-sidecar-smoke: ${path} answered ${response.status}`)
      console.error((await response.text()).slice(0, 400))
    }
  } catch (error) {
    failures += 1
    console.error(`node-sidecar-smoke: ${path} threw — ${error?.stack ?? error}`)
  }
}

// File-loader assets are emitted beside the split chunks. The roster must name the authenticated
// route AND that route must return the real shipped bytes; checking only the JSON allowed a missing
// `.webp` to degrade silently to a placeholder in packaged builds.
try {
  const rosterResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization: auth } })
  const rosterBody = await rosterResponse.json()
  const roster = Array.isArray(rosterBody) ? rosterBody : rosterBody?.data
  const daedalus = Array.isArray(roster) ? roster.find((agent) => agent?.id === "daedalus") : undefined
  if (typeof daedalus?.avatar !== "string" || !daedalus.avatar.startsWith("/api/agent/daedalus/avatar?v=")) {
    throw new Error("the roster did not publish Daedalus's versioned server-owned portrait route")
  }
  const portraitResponse = await fetch(`http://127.0.0.1:${port}${daedalus.avatar}`, {
    headers: { authorization: auth },
  })
  const portrait = new Uint8Array(await portraitResponse.arrayBuffer())
  if (
    !portraitResponse.ok ||
    portraitResponse.headers.get("content-type") !== "image/webp" ||
    portrait.length < 4 ||
    String.fromCharCode(...portrait.slice(0, 4)) !== "RIFF"
  ) {
    throw new Error(`portrait route returned ${portraitResponse.status} ${portraitResponse.headers.get("content-type")}`)
  }

  const fallbackResponse = await fetch(`http://127.0.0.1:${port}/api/agent/portrait-smoke-missing/avatar`, {
    headers: { authorization: auth },
  })
  const fallback = new TextDecoder().decode(await fallbackResponse.arrayBuffer())
  if (
    !fallbackResponse.ok ||
    fallbackResponse.headers.get("content-type") !== "image/svg+xml" ||
    !fallback.startsWith("<svg ")
  ) {
    throw new Error(
      `portrait fallback returned ${fallbackResponse.status} ${fallbackResponse.headers.get("content-type")}`,
    )
  }
} catch (error) {
  failures += 1
  console.error(`node-sidecar-smoke: shipped portrait failed — ${error?.stack ?? error}`)
}

await listener.stop?.(true).catch?.(() => undefined)

if (failures > 0) {
  console.error(`node-sidecar-smoke: ${failures} endpoint(s) failed — the sidecar bundle is broken`)
  process.exit(1)
}
console.log(`node-sidecar-smoke: ${paths.length} endpoints OK`)
process.exit(0)
