#!/usr/bin/env bun
// KB-B tiered dataset acquisition — YAGO 4.5 slices through the /kb/populate API.
//
// YAGO 4.5 (Wikidata normalized: 132M facts, 108 predicates — the KB-C target schema)
// ships as zip archives of Turtle files. The official ~200MB "tiny" edition decompresses
// to >1GB of TTL, so ONE artifact services both starter tiers by ingestion budget:
//
//   --tier 100mb   ≈ 100 MB of raw fact text ingested   (architecture shake-down)
//   --tier 1gb     ≈ the whole tiny edition             (stress the PoC store's limits)
//   --tier full    the 12GB full edition                (KB-C territory — needs Datalevin;
//                                                        the PoC SQLite store WILL crawl)
//
// This is a provision-BEFORE-airgap operation (WAN download). License: CC BY-SA.
// Reports ingestion throughput — the number KB-C decisions need.
//
// Usage:
//   bun script/kb/fetch-yago-tier.ts --tier 100mb --serve http://127.0.0.1:4096 --directory <abs-project-dir>
//   Options: --dest <dir>  (download/extract dir, default ./yago-data)
//            --batch 1000  (facts per populate call)
//            --max-bytes N (override the tier budget)
//            --dry-run     (convert + count, no populate)

import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { Readable } from "node:stream"

const TINY_URL = "https://yago-knowledge.org/data/yago4.5/yago-4.5.0.2-tiny.zip"
const FULL_URL = "https://yago-knowledge.org/data/yago4.5/yago-4.5.0.2.zip"

const args = new Map<string, string>()
const flags = new Set<string>()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!
  if (!key.startsWith("--")) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith("--")) flags.add(key.slice(2))
  else {
    args.set(key.slice(2), next)
    i++
  }
}

const TIER = args.get("tier") ?? "100mb"
const SERVE = args.get("serve")
const DIRECTORY = args.get("directory") ?? process.cwd()
const DEST = args.get("dest") ?? path.join(process.cwd(), "yago-data")
const BATCH = Number(args.get("batch") ?? 1000)
const DRY = flags.has("dry-run")

const budgets: Record<string, { url: string; maxBytes: number }> = {
  "100mb": { url: TINY_URL, maxBytes: 100 * 1024 * 1024 },
  "1gb": { url: TINY_URL, maxBytes: Number.MAX_SAFE_INTEGER },
  full: { url: FULL_URL, maxBytes: Number.MAX_SAFE_INTEGER },
}
const tier = budgets[TIER]
if (!tier) {
  console.error(`unknown tier "${TIER}" — use 100mb | 1gb | full`)
  process.exit(1)
}
const maxBytes = args.get("max-bytes") ? Number(args.get("max-bytes")) : tier.maxBytes
if (!SERVE && !DRY) {
  console.error("pass --serve <url> --directory <abs-project-dir> (or --dry-run)")
  process.exit(1)
}

// ── download (resumable-ish: skips when the file already exists) ────────────────────────
await fs.mkdir(DEST, { recursive: true })
const zipPath = path.join(DEST, path.basename(new URL(tier.url).pathname))
const have = await fs.stat(zipPath).catch(() => undefined)
if (!have?.size) {
  console.log(`downloading ${tier.url} → ${zipPath} …`)
  const res = await fetch(tier.url)
  if (!res.ok || !res.body) {
    console.error(`download failed: HTTP ${res.status}. Offline mode? This is a provision-before-airgap step.`)
    process.exit(1)
  }
  const out = createWriteStream(zipPath)
  let got = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    out.write(chunk)
    got += chunk.length
    if (got % (64 * 1024 * 1024) < chunk.length) console.log(`  … ${(got / 1e6).toFixed(0)} MB`)
  }
  await new Promise((resolve) => out.end(resolve))
  console.log(`downloaded ${(got / 1e6).toFixed(0)} MB`)
} else console.log(`reusing existing ${zipPath} (${(have.size / 1e6).toFixed(0)} MB)`)

// ── extract (bsdtar reads zip on Windows 10+/macOS; unzip fallback for Linux) ───────────
const extractDir = path.join(DEST, path.basename(zipPath, ".zip"))
const already = await fs.readdir(extractDir).catch(() => [])
if (already.length === 0) {
  await fs.mkdir(extractDir, { recursive: true })
  console.log(`extracting …`)
  const tryCmds: string[][] = [
    ["tar", "-xf", zipPath, "-C", extractDir],
    ["unzip", "-o", "-q", zipPath, "-d", extractDir],
  ]
  let ok = false
  for (const cmd of tryCmds) {
    const proc = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" })
    if (proc.exitCode === 0) {
      ok = true
      break
    }
  }
  if (!ok) {
    console.error("could not extract the zip: need `tar` (Windows 10+/macOS) or `unzip` (Linux) on PATH")
    process.exit(1)
  }
}

// find the fact files (skip schema; taxonomy is optional structure — include it last)
const all: string[] = []
async function walk(dir: string) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(p)
    else if (/\.(ttl|nt)$/i.test(entry.name)) all.push(p)
  }
}
await walk(extractDir)
const ordered = [
  ...all.filter((f) => /facts/i.test(path.basename(f)) && !/meta/i.test(path.basename(f))),
  ...all.filter((f) => /taxonomy/i.test(path.basename(f))),
  ...all.filter((f) => !/facts|taxonomy|schema|meta/i.test(path.basename(f))),
]
if (ordered.length === 0) {
  console.error(`no .ttl/.nt files found under ${extractDir}`)
  process.exit(1)
}
console.log(`fact files: ${ordered.map((f) => path.relative(extractDir, f)).join(", ")}`)

// ── TTL line parser (pragmatic: YAGO emits one triple per line) ─────────────────────────
// subject predicate object .   — prefixed names or <IRIs>; literals may carry ^^type/@lang.
const stripDatatype = (value: string) =>
  value
    .replace(/\^\^\S+$/, "")
    .replace(/@[a-zA-Z-]+$/, "")
    .replace(/^"(.*)"$/s, "$1")
const shortenIri = (value: string) => {
  const m = /^<(.+)>$/.exec(value)
  if (!m) return value
  const iri = m[1]!
  const tail = iri.split(/[/#]/).pop()
  return tail ? decodeURIComponent(tail) : iri
}

function parseTriple(line: string): { s: string; p: string; o: string } | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("#") || !trimmed.endsWith(".")) return undefined
  const body = trimmed.slice(0, -1).trim()
  // tokenize: IRIs in <>, literals in "" (may contain spaces), else whitespace-split
  const tokens: string[] = []
  let i = 0
  while (i < body.length && tokens.length < 3) {
    while (body[i] === " " || body[i] === "\t") i++
    if (i >= body.length) break
    if (tokens.length === 2) {
      tokens.push(body.slice(i).trim()) // object = the rest
      break
    }
    if (body[i] === "<") {
      const end = body.indexOf(">", i)
      if (end < 0) return undefined
      tokens.push(body.slice(i, end + 1))
      i = end + 1
    } else {
      let end = i
      while (end < body.length && body[end] !== " " && body[end] !== "\t") end++
      tokens.push(body.slice(i, end))
      i = end
    }
  }
  if (tokens.length !== 3) return undefined
  const [s, p, o] = tokens as [string, string, string]
  // Multi-line Turtle (the schema/SHACL section) leaks fragments into line-based parsing:
  // reject continuation artifacts (trailing , or ;) and bare prefixes ("ys:").
  if (/[,;]$/.test(s) || /[,;]$/.test(p) || /:$/.test(s) || /:$/.test(p)) return undefined
  if (!/^</.test(s) && !s.includes(":")) return undefined
  if (p !== "a" && !/^</.test(p) && !p.includes(":")) return undefined
  return { s: shortenIri(s), p: p === "a" ? "type" : shortenIri(p), o: stripDatatype(shortenIri(o)) }
}

// ── convert + populate with a byte budget + throughput report ───────────────────────────
let ingestedBytes = 0
let parsed = 0
let sent = 0
let batch: Array<{ subject: string; predicate: string; object: string; relation: string; source: string }> = []
const started = Date.now()

async function flush() {
  if (batch.length === 0 || DRY) {
    batch = []
    return
  }
  const res = await fetch(`${SERVE!.replace(/\/$/, "")}/kb/populate?directory=${encodeURIComponent(DIRECTORY)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-novaclaw-directory": DIRECTORY },
    body: JSON.stringify({ facts: batch }),
  })
  if (!res.ok) {
    console.error(`populate failed: HTTP ${res.status} — ${await res.text().catch(() => "")}`)
    process.exit(1)
  }
  sent += batch.length
  batch = []
}

outer: for (const file of ordered) {
  console.log(`ingesting ${path.relative(extractDir, file)} …`)
  // Bun.file().stream() → web stream; readline wants node streams — bridge via Readable.fromWeb
  const nodeStream = Readable.fromWeb(Bun.file(file).stream() as never)
  const lines = readline.createInterface({ input: nodeStream, crlfDelay: Infinity })
  for await (const line of lines) {
    ingestedBytes += line.length + 1
    const triple = parseTriple(line)
    if (!triple) continue
    parsed++
    if (parsed <= 3) console.log(`  sample: ${triple.s} | ${triple.p} | ${triple.o.slice(0, 80)}`)
    batch.push({ subject: triple.s, predicate: triple.p, object: triple.o, relation: "core", source: "yago-4.5" })
    if (batch.length >= BATCH) {
      await flush()
      if (!DRY && sent % 100_000 < BATCH) {
        const secs = (Date.now() - started) / 1000
        console.log(`  ${sent} facts · ${(ingestedBytes / 1e6).toFixed(0)} MB · ${Math.round(sent / secs)} facts/s`)
      }
    }
    if (ingestedBytes >= maxBytes) {
      console.log(`byte budget reached (${(maxBytes / 1e6).toFixed(0)} MB) — stopping`)
      break outer
    }
  }
}
await flush()
const secs = (Date.now() - started) / 1000
console.log(
  `${DRY ? "[dry-run] " : ""}done: parsed ${parsed} triples, ${DRY ? "would send" : "sent"} ${DRY ? parsed : sent} facts ` +
    `from ${(ingestedBytes / 1e6).toFixed(1)} MB in ${secs.toFixed(0)}s (${Math.round((DRY ? parsed : sent) / Math.max(secs, 1))} facts/s)`,
)
if (!DRY && SERVE) {
  const stats = await fetch(`${SERVE.replace(/\/$/, "")}/kb/stats?directory=${encodeURIComponent(DIRECTORY)}`, {
    headers: { "x-novaclaw-directory": DIRECTORY },
  }).then((r) => r.json()).catch(() => undefined)
  console.log("kb stats:", JSON.stringify(stats))
}
