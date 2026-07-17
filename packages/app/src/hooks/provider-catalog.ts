import type { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"

const emptyProviderCatalog: NormalizedProviderListResponse = {
  all: new Map(),
  models: new Map(),
  connected: [],
  default: {},
}

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput = {
  directory?: string
  catalog?: DirectoryCatalog
  global?: NormalizedProviderListResponse
}

export function selectProviderCatalog(input: ProviderCatalogInput) {
  // Prefer the directory-specific catalog once it has loaded AND actually has connected providers;
  // otherwise fall back to the global catalog. Connections are resolved globally (auth lives on the
  // server), so a directory whose catalog lists providers but marks none connected — notably the "/"
  // root that new-session runs under — must not blank the model picker. The global catalog carries
  // the real connected set.
  if (input.directory && input.catalog?.ready && input.catalog.providers.connected.length > 0)
    return input.catalog.providers
  return input.global ?? emptyProviderCatalog
}
