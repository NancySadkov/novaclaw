#!/usr/bin/env bun
// KB-B tier 0 — the SYNTHETIC rock-musicians starter set.
//
// Generates a fully FICTIONAL rock-music universe (bands, musicians, albums, labels,
// cities) as KB facts. Because every entity is invented, no model can answer questions
// about it from parametric memory — a correct answer PROVES the KB retrieval path works.
// Deterministic: same seed → same universe (the eval file stays valid across runs).
//
// Usage:
//   bun script/kb/generate-rockfacts.ts --out rockfacts.jsonl --eval rockfacts-eval.jsonl
//   Options: --bands 150  --seed 20260703  --relation core
//
// Fact shape: { subject, predicate, object, relation, source, confidence }
// Subjects are lowercase-hyphen SLUGS (models can derive them from display names without
// URL-encoding pain); every entity carries a `name` fact with the display string.

interface Fact {
  subject: string
  predicate: string
  object: string
  relation: "core" | "staged"
  source: string
  confidence: number
}

interface EvalQA {
  question: string
  answer: string
  subject: string
  predicate: string
}

// ── deterministic PRNG (mulberry32) ────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!key?.startsWith("--")) continue
  args.set(key.slice(2), process.argv[i + 1] ?? "")
}

const SEED = Number(args.get("seed") ?? 20260703)
const BANDS = Number(args.get("bands") ?? 150)
const RELATION = (args.get("relation") ?? "core") as "core" | "staged"
const SOURCE = `rockfacts-synthetic-v1 seed=${SEED}`
const rand = mulberry32(SEED)

const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
const rangeInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))

// ── fictional vocabulary (syllable-combinatoric; intentionally NOT real names) ─────────
const ADJ = ["Velvet", "Rusted", "Neon", "Hollow", "Static", "Crimson", "Paper", "Glass", "Feral", "Lunar", "Molten", "Granite", "Electric", "Wandering", "Broken", "Silent", "Chrome", "Saffron", "Obsidian", "Peculiar"]
const NOUN = ["Corvids", "Furnaces", "Lanterns", "Vipers", "Prophets", "Engines", "Orchids", "Sirens", "Anchors", "Pylons", "Foxes", "Harbors", "Mirrors", "Wolves", "Turbines", "Meridians", "Sparrows", "Bonfires", "Cellars", "Comets"]
const FIRST = ["Korvath", "Maribel", "Dax", "Ilona", "Ryland", "Sable", "Orin", "Vespera", "Callum", "Zinnia", "Harlan", "Petra", "Joss", "Ondine", "Bram", "Liora", "Castor", "Vada", "Emrick", "Thessaly", "Rooke", "Isolde", "Fenwick", "Marisol"]
const LAST = ["Dreyne", "Vasko", "Quillan", "Marrow", "Hexley", "Solvang", "Petrichor", "Ashgrove", "Brandt", "Okonkwo", "Silvermane", "Tarwater", "Ellsworth", "Vane", "Crowhurst", "Mendel", "Rasky", "Duval", "Northgate", "Palissy"]
const CITY = ["Grey Harbor", "Veldt City", "Ironpool", "Cascabel", "New Tallis", "Port Umber", "Drossford", "Kestrel Falls", "Marrow Bay", "Sunfall", "Ochre Springs", "Vantage Point", "Colderidge", "Bellmouth", "Tarn Hollow"]
const GENRE = ["garage rock", "doom metal", "psychedelic rock", "post-punk", "surf rock", "progressive rock", "glam rock", "krautrock", "shoegaze", "stoner rock", "art rock", "proto-punk"]
const LABEL = ["Cinder Disc Records", "Halcyon Wax", "Grimm Audio", "Northgate Sound", "Tin Ceiling Records", "Ferrous Music", "Opaline Records", "Blue Furnace Recordings"]
const ROLE = ["lead vocals", "lead guitar", "bass guitar", "drums", "keyboards", "rhythm guitar"]
const ALBUM_A = ["Midnight", "Concrete", "Endless", "Borrowed", "Phantom", "Amber", "Savage", "Quiet", "Burning", "Forgotten", "Electric", "Marble"]
const ALBUM_B = ["Arithmetic", "Gardens", "Divide", "Cathedral", "Weather", "Mile", "Machinery", "Postcards", "Latitude", "Ceremony", "Appetite", "Harvest"]

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

// ── generate the universe ───────────────────────────────────────────────────────────────
const facts: Fact[] = []
const evalSet: EvalQA[] = []
const fact = (subject: string, predicate: string, object: string) =>
  facts.push({ subject, predicate, object, relation: RELATION, source: SOURCE, confidence: 1 })

const usedBandNames = new Set<string>()
const usedPeople = new Set<string>()

for (let b = 0; b < BANDS; b++) {
  let bandName = ""
  do bandName = `The ${pick(ADJ)} ${pick(NOUN)}`
  while (usedBandNames.has(bandName))
  usedBandNames.add(bandName)
  const band = slug(bandName)
  const founded = rangeInt(1962, 1999)
  const city = pick(CITY)
  const genre = pick(GENRE)
  const label = pick(LABEL)

  fact(band, "type", "band")
  fact(band, "name", bandName)
  fact(band, "genre", genre)
  fact(band, "founded_in", String(founded))
  fact(band, "origin_city", city)
  fact(band, "record_label", label)
  if (rand() < 0.35) fact(band, "disbanded_in", String(rangeInt(founded + 3, 2015)))

  const memberCount = rangeInt(3, 5)
  const roles = [...ROLE]
  for (let m = 0; m < memberCount; m++) {
    // FIRST×LAST is only 480 combos — fewer than the musicians a big universe needs, so
    // a bare uniqueness loop would spin forever. Fall back to a generational suffix.
    let person = `${pick(FIRST)} ${pick(LAST)}`
    for (let attempt = 0; usedPeople.has(person) && attempt < 8; attempt++)
      person = `${pick(FIRST)} ${pick(LAST)}`
    if (usedPeople.has(person)) {
      const suffixes = ["Jr", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
      const base = person
      for (let n = 0; usedPeople.has(person); n++)
        person = `${base} ${suffixes[n % suffixes.length]}${n >= suffixes.length ? ` ${1 + Math.floor(n / suffixes.length)}` : ""}`
    }
    usedPeople.add(person)
    const pslug = slug(person)
    const role = roles.splice(Math.floor(rand() * roles.length), 1)[0]!
    fact(pslug, "type", "musician")
    fact(pslug, "name", person)
    fact(pslug, "member_of", bandName)
    fact(pslug, "role", role)
    fact(pslug, "born_in", String(rangeInt(founded - 25, founded - 16)))
    if (m === 0)
      evalSet.push({
        question: `Which band is the musician ${person} a member of?`,
        answer: bandName,
        subject: pslug,
        predicate: "member_of",
      })
    if (m === 1)
      evalSet.push({
        question: `What is ${person}'s role in ${bandName}?`,
        answer: role,
        subject: pslug,
        predicate: "role",
      })
  }

  const albumCount = rangeInt(2, 5)
  const usedTitles = new Set<string>()
  for (let a = 0; a < albumCount; a++) {
    let title = ""
    do title = `${pick(ALBUM_A)} ${pick(ALBUM_B)}`
    while (usedTitles.has(title))
    usedTitles.add(title)
    const aslug = slug(`${title} ${bandName}`)
    const year = rangeInt(founded, Math.min(founded + 20, 2020))
    fact(aslug, "type", "album")
    fact(aslug, "name", title)
    fact(aslug, "album_by", bandName)
    fact(aslug, "released_in", String(year))
    if (a === 0)
      evalSet.push({
        question: `In which year did ${bandName} release the album "${title}"?`,
        answer: String(year),
        subject: aslug,
        predicate: "released_in",
      })
  }

  if (b % 3 === 0)
    evalSet.push({
      question: `In which city was the band ${bandName} formed?`,
      answer: city,
      subject: band,
      predicate: "origin_city",
    })
  if (b % 5 === 0)
    evalSet.push({
      question: `In which year was the band ${bandName} founded?`,
      answer: String(founded),
      subject: band,
      predicate: "founded_in",
    })
}

console.log(`generated ${facts.length} facts, ${evalSet.length} eval QAs (seed=${SEED}, bands=${BANDS})`)

// ── outputs ─────────────────────────────────────────────────────────────────────────────
const out = args.get("out")
if (out) {
  await Bun.write(out, facts.map((f) => JSON.stringify(f)).join("\n") + "\n")
  console.log(`facts → ${out}`)
}
const evalOut = args.get("eval")
if (evalOut) {
  await Bun.write(evalOut, evalSet.map((q) => JSON.stringify(q)).join("\n") + "\n")
  console.log(`eval  → ${evalOut}`)
}

// (The old --populate mode + the KB-V seed path are retired; this generator now just emits the
// fact/eval JSONL that the query-eval harnesses read.)
if (!out && !evalOut) {
  console.log("nothing to do: pass --out and/or --eval file paths")
  process.exit(1)
}
