/**
 * The browser-facing barrel. It re-exports the typed client and the generated wire types, and it
 * must stay reachable from a renderer, so **nothing under this graph may import anything outside
 * this package** — no `node:` builtin, no npm dependency.
 *
 * ⚠️ This file used to also `export * from "./server.js"`, which put `cross-spawn` and
 * `node:child_process` into the import graph of 24 renderer files: a browser bundle whose barrel
 * could spawn `novaclaw serve`. `server.ts` is deleted (2026-07-29) — launching an instance is a
 * HARNESS concern that `packages/novaclaw`'s `serve` command and the desktop's `spawnLocalServer`
 * already own, and the SDK's copy had exactly two callers, both inside this package. Standing
 * decision (todo.md): *`@novaclaw/sdk` carries ZERO runtime dependencies.*
 *
 * That decision is not a comment — `test/zero-runtime-dependencies.test.ts` reads this package's
 * manifest and walks this graph.
 */
export * from "./client.js"
