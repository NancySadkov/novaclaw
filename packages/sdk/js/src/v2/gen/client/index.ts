// Vendored from @hey-api/openapi-ts 0.90.4 (MIT) — see licenses/hey-api-LICENSE-MIT.txt and NOTICE.
// NOT regenerated: NovaClaw's own emitter (packages/sdk/js/script/emitter.ts) writes only
// types.gen.ts and sdk.gen.ts. Edit this file in place.

export type { Auth } from "../core/auth.gen.js"
export type { QuerySerializerOptions } from "../core/bodySerializer.gen.js"
export {
  formDataBodySerializer,
  jsonBodySerializer,
  urlSearchParamsBodySerializer,
} from "../core/bodySerializer.gen.js"
export { buildClientParams } from "../core/params.gen.js"
export { serializeQueryKeyValue } from "../core/queryKeySerializer.gen.js"
export { createClient } from "./client.gen.js"
export type {
  Client,
  ClientOptions,
  Config,
  CreateClientConfig,
  Options,
  RequestOptions,
  RequestResult,
  ResolvedRequestOptions,
  ResponseStyle,
  TDataShape,
} from "./types.gen.js"
export { createConfig, mergeHeaders } from "./utils.gen.js"
