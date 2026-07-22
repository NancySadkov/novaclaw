export * as MessengerGatewayHandle from "./gateway-handle"

import type { Interface } from "./gateway"

// The ONE live gateway's runtime handle — a leaf module deliberately free of value imports.
// WHY THIS EXISTS (module-graph law): the `messenger` tool lives in the location tool graph
// (tool/builtins → location-services → session.ts), and gateway.ts imports session.ts (it
// prompts sessions) — so a tool → gateway MODULE edge closes an import cycle that breaks the
// whole type graph. The tool therefore never imports gateway.ts for value: the gateway sets
// this handle when it builds (and clears it on teardown), and the tool reads it at CALL time,
// degrading legibly when no gateway is running. Singleton by construction — exactly one
// gateway exists per process (its boot log is the tripwire), so last-set-wins is single-set.

let current: Interface | undefined

export const set = (gateway: Interface): void => {
  current = gateway
}

export const clear = (gateway: Interface): void => {
  if (current === gateway) current = undefined
}

export const get = (): Interface | undefined => current
