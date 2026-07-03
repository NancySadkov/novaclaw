# KB datasets (KB-B) — tiered, incremental, provision-before-airgap

The KB facade (`/kb/*`, see the `kb` ad-hoc tool recipe) is backend-swappable: today a
built-in SQLite PoC store, later Datalevin on the Spark/NAS (KB-C). These scripts feed it
datasets at increasing scale so the architecture is tested **incrementally** — each tier
exists to surface the next bottleneck before the 500–1000 GB endgame.

| Tier | Dataset | Size | Purpose |
|---|---|---|---|
| **0** | `generate-rockfacts.ts` — synthetic, fictional rock musicians | ~5 k facts | **Proof of retrieval**: every entity is invented, so no model can answer from parametric memory — a correct answer proves the KB path works. Deterministic (seeded); ships an eval QA set. |
| **1** | `fetch-yago-tier.ts --tier 100mb` — YAGO 4.5 tiny slice | ~100 MB text | Architecture shake-down: populate throughput, query latency at ~1M facts, PoC store behavior. |
| **2** | `fetch-yago-tier.ts --tier 1gb` — the whole YAGO 4.5 "tiny" edition | ~1 GB text | Stress the PoC store to its limits; produces the facts/s + query-latency numbers the KB-C decision gates need. |
| **3** | `--tier full` — YAGO 4.5 full (12 GB zip, 132M facts) | ~142 GB raw | **KB-C territory.** The PoC SQLite store will crawl — this tier is what Datalevin on the Spark is for. Run it only to measure where things break. |

## Why YAGO 4.5 (and not e.g. dumped MSDN)

- It is the **KB-C target dataset** (132M facts, **108 predicates** — a schema a 35B query
  author can hold), so every tier exercises exactly the schema the endgame uses.
- Turtle-in-zip, no auth, CC BY-SA, official tiny edition for small tiers.
- Alternatives if a *thematic* corpus is ever wanted: MusicBrainz JSON dumps (CC0, matches
  the tier-0 rock theme with real long-tail artists), or archive.org's Windows 3.1 SDK
  help files (obscure API quirks — but .HLP parsing is a project of its own). Neither
  exercises the KB-C schema, so YAGO stays the default.

## Rituals

```sh
# tier 0 — generate + populate + keep the eval set
bun script/kb/generate-rockfacts.ts --out rockfacts.jsonl --eval rockfacts-eval.jsonl \
  --populate http://127.0.0.1:4096 --directory <abs-project-dir>

# tier 1/2 — download (WAN! do it BEFORE going airgapped), convert, populate, measure
bun script/kb/fetch-yago-tier.ts --tier 100mb --serve http://127.0.0.1:4096 --directory <abs-project-dir>

# live retrieval eval vs qwen (root repo): control (no KB) vs KB-assisted answers
bun tests/kb-rockfacts-smoke.ts
```

Both populate paths report **facts/s**; keep the numbers — they are the evidence base for
the KB-C gates (Datalevin ingestion benchmark, qwen-Datalog eval).

Facts land with `relation: "core"` (curated dataset) — agent-written facts stay `staged`
forever, so the imported ground truth and model output remain distinguishable.
