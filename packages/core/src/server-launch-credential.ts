export * as ServerLaunchCredential from "./server-launch-credential"

/**
 * The credential a NovaClaw server was STARTED with, as given on the command line.
 *
 * 🔴 This exists because the server used to take its incoming API token from the
 * `NOVACLAW_SERVER_PASSWORD` environment variable, and that made an instance's security an accident of
 * whatever the launching shell happened to export. Measured on the owner's machine: a dev server
 * inherited a password exported for an unrelated session, so it came up authenticated while the script
 * driving it believed it was open — and the same variable leaking into a test run or an agent's
 * `bash` call changes what a supposedly reproducible launch means. Environment is not a
 * configuration channel for a local-first product; it is a shared mutable global owned by whoever
 * last touched the shell.
 *
 * So the rule this module enforces: **the only sources of a launch credential are the explicit CLI
 * options (`--password`, `--username`) and the settings store.** Never the environment. The stored
 * value still outranks a launch value at auth time (`ServerAuth.resolve`), which keeps the
 * Settings → Instances surface the runtime authority — this module only replaces the env half.
 *
 * ⚠️ Setting and reading are separate calls on purpose. The CLI parses argv and calls `set` BEFORE
 * any auth layer is built, so the layers can stay lazy and still see the value; a layer that read
 * argv itself would re-parse the world at every request.
 *
 * Tests assign through `Flag.NOVACLAW_SERVER_PASSWORD`, which forwards here — one holder, not a
 * second registry for the same light (the lesson `flag.ts` records for
 * `NOVACLAW_EXPERIMENTAL_WORKSPACES`: two registries is how a switch ends up wired to neither).
 */

const DEFAULT_USERNAME = "novaclaw"

let password: string | undefined
let username: string | undefined

/** Record what argv asked for. `undefined` leaves a field alone; an explicit empty string clears it. */
export function set(input: { readonly password?: string | undefined; readonly username?: string | undefined }): void {
  if (input.password !== undefined) password = input.password === "" ? undefined : input.password
  if (input.username !== undefined) username = input.username === "" ? undefined : input.username
}

/** The launch password, or undefined when the instance was started open (or with only a stored one). */
export function get(): { readonly password: string | undefined; readonly username: string } {
  return { password, username: username ?? DEFAULT_USERNAME }
}

/** Forget everything (tests, and a process that starts a second instance graph). */
export function clear(): void {
  password = undefined
  username = undefined
}

/** True when a launch credential was actually supplied, so a caller can warn about an open server. */
export function isSet(): boolean {
  return password !== undefined && password !== ""
}
