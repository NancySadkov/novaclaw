import { expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import { selectProviderCatalog } from "./provider-catalog"

const catalog = (id: string): NormalizedProviderListResponse => ({
  all: new Map([[id, { id, name: id, api: { type: "native", settings: {} }, request: { headers: {}, body: {} } }]]),
  models: new Map(),
  connected: [id],
  default: { [id]: `${id}-model` },
})
const empty: NormalizedProviderListResponse = { all: new Map(), models: new Map(), connected: [], default: {} }

test("uses the ready directory catalog when it has connected providers", () => {
  const directory = catalog("directory")
  expect(
    selectProviderCatalog({
      directory: "/repo",
      catalog: { ready: true, providers: directory },
      global: catalog("global"),
    }),
  ).toBe(directory)
})

test("falls back to global while the directory catalog is unready", () => {
  const global = catalog("global")
  expect(
    selectProviderCatalog({ directory: "/repo", catalog: { ready: false, providers: catalog("directory") }, global }),
  ).toBe(global)
})

test("falls back to global when a ready directory catalog has no connected providers", () => {
  // The "/" root lists providers in `all` but marks none connected — connections are resolved
  // globally, so the picker must use the global catalog rather than blank out.
  const global = catalog("global")
  const root: NormalizedProviderListResponse = { ...catalog("root"), connected: [] }
  expect(selectProviderCatalog({ directory: "/", catalog: { ready: true, providers: root }, global })).toBe(global)
})

test("falls back to global when there is no directory", () => {
  const global = catalog("global")
  expect(selectProviderCatalog({ global })).toBe(global)
})

test("returns an empty catalog when nothing is available", () => {
  expect(selectProviderCatalog({})).toEqual(empty)
  expect(selectProviderCatalog({ directory: "/repo", catalog: { ready: false, providers: catalog("d") } })).toEqual(
    empty,
  )
})
