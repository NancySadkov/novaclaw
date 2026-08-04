// The serve-supervision restart policy now lives in core (packages/core/src/process/supervise.ts)
// so the Ladybug memory sidecar supervisor can reuse the same battle-tested ladder. This file is a
// thin re-export to keep serve.ts + supervise.test.ts (which import from `../supervise`) unchanged.
export * from "@novaclaw/core/process/supervise"
