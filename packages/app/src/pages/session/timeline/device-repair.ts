import type { NovaclawClient } from "@novaclaw/sdk/v2/client"

/** The one-click repair for a refused Device pin. Null means remove the sparse override. */
export const unpinSessionDevice = (client: NovaclawClient, sessionID: string) =>
  client.v2.session.update({ sessionID, device: null })
