export * as ConfigPluginSpec from "./plugin-spec"

import { Schema } from "effect"

// The resolver-domain plugin spec: a package string or a `[package, options]` tuple. Distinct from
// the persisted V2 `ConfigPlugin.Plugin` entry (`string | { package, options }`) — this tuple shape is
// what the plugin specifier resolver (`novaclaw/src/plugin/shared.ts`) and the origin-dedup helpers
// (`novaclaw/src/config/plugin.ts`) consume.
export const Options = Schema.Record(Schema.String, Schema.Unknown)
export type Options = Schema.Schema.Type<typeof Options>

export const Spec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, Options]))])
export type Spec = Schema.Schema.Type<typeof Spec>
