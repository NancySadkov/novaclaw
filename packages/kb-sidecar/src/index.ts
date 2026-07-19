// @novaclaw/kb-sidecar — the Ladybug graph-memory engine, run as a supervised NODE process
// (the native addon segfaults under Bun; notes/kb-graph-plan.md §2.1). This entry re-exports the
// store; the loopback HTTP server + supervision wiring land in later P1b slices.
export { MemoryStore } from "./store"
export type { MemoryInput, EdgeInput, SearchInput, SearchHit, MemoryRow, MemoryKind, Relation } from "./store"
