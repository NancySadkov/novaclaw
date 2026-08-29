/**
 * Built-in surfaces a persisted launcher manifest may open.
 *
 * This module is deliberately renderer-safe: both the instance-side manifest validator and the
 * HTML shell import the same closed vocabulary. The values are route ids, not paths a model can
 * invent; the path stays an implementation detail owned by this build.
 */
export const MANIFEST_ROUTE_TARGETS = {
  contacts: "/tasks",
  notes: "/notes",
  files: "/files",
  calendar: "/calendar",
  recipes: "/recipes",
  skills: "/skills",
  registry: "/registry",
  debug: "/debug",
  trash: "/trash",
  terminal: "/terminal",
} as const satisfies Record<string, `/${string}`>

export type ManifestRouteId = keyof typeof MANIFEST_ROUTE_TARGETS

export const MANIFEST_ROUTE_IDS = Object.freeze(Object.keys(MANIFEST_ROUTE_TARGETS) as ManifestRouteId[])

export function isManifestRouteId(value: string): value is ManifestRouteId {
  return Object.hasOwn(MANIFEST_ROUTE_TARGETS, value)
}

/** Resolve a manifest's closed route id to the path registered by this build. */
export function manifestRoutePath(value: string): (typeof MANIFEST_ROUTE_TARGETS)[ManifestRouteId] | undefined {
  return isManifestRouteId(value) ? MANIFEST_ROUTE_TARGETS[value] : undefined
}
