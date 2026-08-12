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
 * subsystem registry, config the store graph, tool ids the registry, find the filesystem layer.
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
  "/config",
  "/experimental/tool/ids",
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

await listener.stop?.(true).catch?.(() => undefined)

if (failures > 0) {
  console.error(`node-sidecar-smoke: ${failures} endpoint(s) failed — the sidecar bundle is broken`)
  process.exit(1)
}
console.log(`node-sidecar-smoke: ${paths.length} endpoints OK`)
process.exit(0)
