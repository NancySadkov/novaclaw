import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { LLMClient, RequestExecutor } from "@novaclaw/llm/route"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { Offline } from "../offline"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })

// OFF-A: the ONE shared HttpClient is the offline-mode chokepoint. Every Effect
// HTTP call (V2 LLM RequestExecutor, webfetch, probe, share, …) rides this node,
// so the offline allowlist guard composes here — a no-op when offline mode is
// off (Offline.guard checks a snapshot policy per request, zero I/O).
export const httpClient = makeGlobalNode({
  service: HttpClient.HttpClient,
  layer: Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const offline = yield* Offline.Service
      const base = yield* HttpClient.HttpClient
      return Offline.guard(base, offline)
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer)),
  deps: [Offline.node],
})
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient],
})
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"
