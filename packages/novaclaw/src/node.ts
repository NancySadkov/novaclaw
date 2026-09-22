import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
import { OwnedProcesses } from "@novaclaw/core/util/owned-processes"

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { Database } from "@novaclaw/core/database/database"

/** Apply Electron's explicit launch credential inside this server bundle before its auth graph exists. */
export function configureServerLaunchCredential(input: { readonly password?: string; readonly username?: string }) {
  ServerLaunchCredential.clear()
  ServerLaunchCredential.set(input)
}

/** Reap every agent-launched OS process still registered as owned. The sidecar calls this on its
 *  stop path — a listener replacement never passes through here, only a real shutdown does. */
export const killOwnedProcesses = (): Promise<void> => OwnedProcesses.killAll()
