import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"

/** Keep the sidecar on the complete instance selected by the desktop parent. In particular, never
 * redirect state to Electron userData: auth.json lives in the instance data home and must be opened
 * with the credential key from the matching instance state home.
 *
 * 🔴 The credential is recorded IN PROCESS, not exported. This function used to write
 * `NOVACLAW_SERVER_PASSWORD` into `process.env`, and that was the ONLY reason the desktop's sidecar
 * authenticated at all: the `password:` argument it also passes to `Server.listen` is not a field of
 * `ListenOptions`, so it reached nothing. The server now takes its launch credential exclusively from
 * the CLI's `--password` / `--username` or from the settings store, so this is the equivalent, explicit
 * call for a parent that hosts the server in-process rather than spawning it.
 *
 * ⚠️ Order matters: this must run before the server module is imported, because the auth layer reads
 * the holder when the graph builds. The call site in `sidecar.ts` sits ahead of the one big import for
 * exactly that reason. */
export function prepareSidecarEnv(password: string) {
  ServerLaunchCredential.set({ password, username: "novaclaw" })
}
