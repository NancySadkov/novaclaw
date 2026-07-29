/**
 * Drive a running NovaClaw instance from the typed client.
 *
 * ⚠️ This example used to call `createNovaclawServer()` and launch the instance itself. That
 * function is gone (2026-07-29): spawning `novaclaw serve` is a harness concern the CLI and the
 * desktop already own, and keeping a process spawner in the SDK cost the package its one runtime
 * dependency — see `src/v2/index.ts`. So START THE INSTANCE FIRST:
 *
 *     novaclaw serve --port 4096
 *     # …or, from this repo's root, without installing:
 *     bun run --conditions=browser packages/novaclaw/src/index.ts serve --port 4096
 *
 * then, in another shell AT THE REPO ROOT (the glob below is repo-relative):
 *
 *     bun run packages/sdk/js/example/example.ts
 *
 * Point it at a different instance with NOVACLAW_URL.
 */
import { createNovaclawClient } from "@novaclaw/sdk/v2"
import { pathToFileURL } from "bun"

const baseUrl = process.env["NOVACLAW_URL"] ?? "http://localhost:4096"
const client = createNovaclawClient({ baseUrl, directory: process.cwd() })

// Name the missing subsystem instead of failing with a bare `fetch failed` twenty lines later.
const health = await client.global.health()
if (health.error || !health.data) {
  console.error(`no NovaClaw instance answering at ${baseUrl} — start one with \`novaclaw serve\` (see above)`)
  process.exit(1)
}

const input = await Array.fromAsync(new Bun.Glob("packages/core/*.ts").scan())

await Promise.all(
  input.map(async (file) => {
    const session = await client.v2.session.create({})
    const sessionID = session.data!.data.id
    console.log("processing", file)
    await client.v2.session.prompt({
      sessionID,
      prompt: {
        text: "Write tests for every public function in this file.",
        files: [{ uri: pathToFileURL(file).href, name: file }],
      },
    })
    console.log("done", file)
  }),
)
