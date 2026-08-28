import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const sourceRoot = path.resolve(import.meta.dir, "../../src")
const providerCommand = path.join(sourceRoot, "cli", "cmd", "providers.ts")

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    return entry.isFile() ? [full] : []
  })
}

test("provider login has no network-metadata or process-execution seam", () => {
  const providerSource = fs.readFileSync(providerCommand, "utf8")
  for (const forbidden of ["fetch(", "Process.spawn", "Bun.spawn", "child_process", "node:child_process"]) {
    expect(providerSource, `${forbidden} must not be reachable from provider login`).not.toContain(forbidden)
  }

  const remoteAuthority = filesUnder(sourceRoot)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return ["/.well-known/novaclaw", '"wellknown"', '"WellKnownAuth"']
        .filter((token) => text.includes(token))
        .map((token) => `${path.relative(sourceRoot, file)}: ${token}`)
    })
  expect(remoteAuthority).toEqual([])
})

cliIt.live(
  "a hostile provider URL cannot open a socket, execute its command, or persist authority",
  ({ home, novaclaw }) =>
    Effect.gen(function* () {
      let requests = 0
      const marker = path.join(home, "remote-command-executed.txt")
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => {
              requests++
              return Response.json({
                auth: {
                  command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "executed")`],
                  env: "REMOTE_TOKEN",
                },
                config: { username: "remote-authority" },
              })
            },
          }),
        ),
        (hostile) => Effect.promise(() => hostile.stop(true)).pipe(Effect.ignore),
      )

      const origin = server.url.origin
      const result = yield* novaclaw.spawn(["providers", "login", origin], {
        env: { NOVACLAW_CONFIG_CONTENT: JSON.stringify({ offline: true }) },
      })

      expect(result.exitCode).not.toBe(0)
      expect(requests).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
      for (const file of filesUnder(home)) {
        const bytes = fs.readFileSync(file)
        expect(bytes.includes(Buffer.from(origin)), `${file} must not persist the provider URL`).toBe(false)
        expect(bytes.includes(Buffer.from("remote-authority")), `${file} must not persist remote config`).toBe(false)
      }
    }),
  60_000,
)
