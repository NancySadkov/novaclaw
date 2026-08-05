import os from "os"
import path from "path"

process.env.NOVACLAW_DB = ":memory:"
process.env.NOVACLAW_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.NOVACLAW_DISABLE_MODELS_FETCH = "true"

/**
 * 🔴 **Point the whole instance home at a throwaway directory — `NOVACLAW_DB=":memory:"` is NOT enough.**
 *
 * That variable isolates the SQLite database and nothing else. Everything resolved through
 * `Global.Path.*` still landed in the developer's REAL instance home, and at least one subsystem reads
 * it on the hot path: the memory graph opens `join(Global.Path.data, "memory", "graph")`
 * (`kb-graph/memory.ts`), so the session runner's auto-recall pulled the developer's actual saved
 * memories into a test's system prompt.
 *
 * Found 2026-08-05 when a steering claim failed with eleven lines of the owner's personal notes
 * injected into the request under *"Relevant things you remember…"*. Three separate problems, and the
 * first is the one that makes this urgent:
 *
 *  1. **Tests could WRITE to the developer's real memory store.** Post-drain memory extraction runs on
 *     every drain; it happened to return empty here, but nothing about the wiring prevented a write.
 *  2. **Tests were not deterministic** — they depended on whatever happened to be in that store, which
 *     is why a claim that passed all afternoon began failing without any code change.
 *  3. **Test output leaked personal data** into logs and assertion diffs.
 *
 * `NOVACLAW_HOME` is the documented single-knob escape hatch (AGENTS.md pitfall #0): it moves config,
 * data, state and cache together. PID-scoped, matching `test/fixture/tmpdir.ts`, so parallel runs cannot
 * collide and a leftover directory is attributable.
 */
process.env.NOVACLAW_HOME = path.join(os.tmpdir(), "novaclaw-test-home", String(process.pid))
