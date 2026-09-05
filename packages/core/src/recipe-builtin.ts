export * as RecipeBuiltin from "./recipe-builtin"

import { Recipe } from "./recipe"

/**
 * The recipes NovaClaw ships with (AGENTS.md → *Recipes are source code for the AI era*).
 *
 * They do double duty: a showcase of what the OS can cook, AND the install's health check — a user clicks
 * one and finds out whether THEIR NovaClaw actually works, which reads as a feature rather than a test
 * suite. So the set deliberately spans the real capability axes: a toolchain (compile + run C), long-horizon
 * exact math, browser/HTML generation, live web research, and creative single-file code.
 *
 * Defined as MODULE CONSTANTS, not loose .md files on disk, so they cannot be lost by an
 * electron-builder asset path — they ship inside the JS bundle and are seeded to the recipes folder on
 * first run, after which the user owns them (edit, copy, delete like any other).
 *
 * ⚠️ Keep every prompt TOOLCHAIN-AGNOSTIC. These run on strangers' machines: discover the compiler, do
 * not hardcode one person's install path.
 *
 * ⚠️ **`needs` is declared only where it is TRUE and CHECKABLE** (ruling 14's one machine-read field —
 * `recipe.ts` → the `needs` section, read by `recipe.run` before a cook starts). Two of the seven declare
 * one; the rest declare nothing, and the two most interesting absences are worth stating out loud:
 *
 *  · **`install-health-check` declares NOTHING, deliberately.** Its entire job is to run on a machine
 *    that may be broken and REPORT what is missing, so a door check would refuse the one recipe designed
 *    for exactly that machine. A prerequisite gate on the diagnostic is the diagnostic failing.
 *  · **`osint-brief` declares nothing either**, though it plainly wants web search and web fetch: those
 *    are kernel tools and instance configuration, not host-capability facts a person can verify on their
 *    own machine, and a declaration nothing can probe would only ever report "I could not check this".
 *
 * ⚠️ The health check's IMAGE row (added 2026-08-12) is where the *explicit unknowns* vocabulary earns
 * its keep (`notes/reports/receipt-unknowns-vocabulary-2026-08-12.md`). The image path runs through a
 * WASM resizer shipped as a bundled asset — exactly the kind of file an electron-builder path change
 * loses silently, and otherwise exercised only when a user happens to attach a picture. But a
 * TEXT-ONLY model cannot see the image either, and reporting that as NOT WORKING would blame the
 * install for a model capability. So the row spells the two apart: NOT WORKING is the instance,
 * NOT AVAILABLE is the model — `measurement-failed` versus `not-applicable`.
 *
 * A declaration must be a fact a normal person could verify by hand — never a package list, which is the
 * dependency manifest ruling 14 forbids under the name "configuration".
 *
 * ⚠️ **`produces` is the OTHER machine-read field, and it is why these prompts NAME their output files.**
 * A cook's verdict was prose until now, so nothing could mechanically read whether it worked;
 * `recipe-verify.ts` fixes that by checking, after the cook, that the artifacts a
 * recipe declares are actually on disk and actually the shape their name implies. That only works if the
 * prompt asks for a FIXED filename, so four of the seven gained one word ("save it as `pi.txt`") — a
 * postcondition naming a file the prompt never requested would be a guaranteed false NOT WORKING, which
 * ruling 2 rules out. `test/recipe-produces.test.ts` enforces exactly that: every declared artifact must
 * appear in its own recipe's prompt.
 *
 * ⚠️ **Two deliberate absences, for the same reason `needs` has two.**
 *
 *  · **`install-health-check` declares only `health.txt`, not the PNG from its IMAGE row.** Writing image
 *    bytes depends on what the model and the host happen to have (a python, a base64), so an absent
 *    `health.png` is not evidence that the install is broken — and a check that reports NOT WORKING when
 *    it does not know is exactly the fault-described-falsely ruling 2 forbids. The image row stays prose,
 *    where its own NOT WORKING / NOT AVAILABLE wording already keeps the instance apart from the model.
 *  · **No compiled binary is ever declared.** `gcc -o hello` yields `hello` on Linux and `hello.exe` under
 *    MinGW, so a fixed name would fail on one platform for a reason that has nothing to do with the
 *    install. The two C recipes declare the program's captured OUTPUT instead, which proves compile AND
 *    run happened and is spelled the same everywhere.
 *
 * ⚠️ Seeding is non-destructive, so adding `needs` to a builtin only reaches installs that have not
 * seeded that slug yet. Existing users keep their copy — they own it once it is on their disk — which is
 * correct, and is why nothing here should be understood as a migration.
 */

export interface Builtin extends Recipe.SaveInput {
  readonly slug: string
  readonly name: string
}

export const BUILTINS: readonly Builtin[] = [
  {
    slug: "install-health-check",
    name: "Install health check",
    description: "Fast end-to-end check that this NovaClaw can actually work — run this first.",
    // ⚠️ NO `needs:` — and do not add one. This recipe exists to run on a machine that may be missing
    // everything and tell the user what is missing; a prerequisite gate here would refuse the diagnostic
    // precisely when it is the thing to run. It is also where the refusal on the OTHER recipes sends
    // people, so it has to be reachable from a broken install by definition.
    produces: ["health.txt"],
    prompt: `Check whether this NovaClaw installation is working, then report a short verdict table.

Test each capability once, in this order, and keep it quick — no deep work:

1. **Shell** — run a trivial command (print the working directory).
2. **Write a file** — create \`health.txt\` here containing the current date, then read it back.
3. **Toolchain** — find out which of these exist on PATH and report versions: a C compiler
   (\`cc\`, \`gcc\`, \`clang\`), \`python3\`/\`python\`, \`node\`, \`git\`. Do not install anything. If a
   lookup itself fails — a folder you are not allowed to read, a drive that is not there — that is
   COULD NOT CHECK, not "missing".
4. **Web search** — search for one current fact and report whether results came back. If searching is
   turned off, unconfigured, blocked by offline mode, or the search service errors or rate-limits you,
   that is COULD NOT CHECK: it says nothing about this computer.
5. **Web fetch** — fetch one page you found and report whether you got real text (not an empty shell).
   A page that times out, refuses you, or is unreachable is COULD NOT CHECK. Only a fetch tool that ran
   and returned an empty shell is NOT WORKING.
6. **Images** — write a small PNG here (any tiny image you can produce with the tools you have), then
   READ that file back. Report WORKING if you can say what is in it, NOT WORKING if reading it failed,
   and NOT AVAILABLE if you cannot see images at all — a text-only model is not a broken install.

Then write a table with a row per capability: WORKING / NOT WORKING / NOT AVAILABLE / COULD NOT CHECK,
plus one short note each. End with a single sentence: is this install healthy enough to run the other
recipes?

The four words mean four different things and picking the wrong one makes the report worse than no
report:

- **WORKING** — you did the thing and it worked.
- **NOT WORKING** — you did the thing on THIS COMPUTER and this computer did not do its job. This is the
  only row that says something is wrong with the install.
- **NOT AVAILABLE** — the AI model you are cannot do this at all. Nothing is wrong with the install.
- **COULD NOT CHECK** — you never got a real answer: a network that did not respond, a service that
  refused or errored, a path you were not allowed to read, a tool that is not switched on. You learned
  nothing about this computer, so do not report anything about it.

⚠️ Never write NOT WORKING because something off this machine failed. A dead endpoint, a timeout, or a
refused request is COULD NOT CHECK — say what stopped you and what the user could do about it. The final
sentence must judge the install ONLY on the rows you actually measured.

Be honest — a NOT WORKING row is the useful output here, not a failure. Do not fix anything and do not
install anything; just report.`,
  },
  {
    slug: "hello-c",
    name: "Hello, C",
    description: "Compiles and runs a C99 program — the toolchain smoke test.",
    // The prompt below spends 40 lines on finding a compiler and names "reporting no compiler found" as
    // a way to FAIL the task. Stating it here means the answer arrives in milliseconds, with the search
    // set named, instead of after a cook that could only ever end there.
    needs: ["a C compiler"],
    produces: ["hello.c", "hello.out.txt"],
    prompt: `Write, compile and run a C99 "hello world" program in this folder.

Steps, in this order:
1. **Write \`hello.c\` first**, before looking for anything. Valid C99, includes what it uses, \`return 0\`
   from \`main\`. Do this even if you suspect no compiler is installed — the file is the deliverable.
2. Find the compiler, in exactly this order, and STOP at the first hit:
   a. \`cc --version\`, then \`gcc --version\`, then \`clang --version\` (on PATH).
   b. If none are on PATH and you are on Windows, test these exact paths with one \`ls\` each:
      \`C:/soft/w64devkit/bin/gcc.exe\`, \`C:/msys64/mingw64/bin/gcc.exe\`,
      \`C:/mingw64/bin/gcc.exe\`, \`C:/TDM-GCC-64/bin/gcc.exe\`.
      A compiler that is installed but not on PATH is normal on Windows.
   You may **not** conclude "no compiler" until every path in (b) has actually been tested. Do not go
   hunting with wildcard \`dir\`/\`find\` sweeps — they are slow and they are how this task gets lost.
3. Compile with warnings on (\`-std=c99 -Wall -Wextra\`) and fix any warning your own code caused.
   If you found the compiler off-PATH (case 2b), **append** its directory to PATH for the build:
   \`PATH="$PATH:/c/soft/w64devkit/bin" gcc -std=c99 -Wall -Wextra -o hello.exe hello.c\`.
   Two traps here, both of which look like a broken toolchain when you hit them:
   - Calling gcc by full path *without* its directory on PATH fails with
     \`cannot execute 'as'\` — gcc finds its own assembler and linker through PATH.
   - **Prepending** instead of appending shadows the shell's \`ls\`/\`head\`/\`cat\` with the toolchain's
     BusyBox versions, and your later commands start failing for unrelated-looking reasons.
4. Run the binary, show its actual output, and **save that output to \`hello.out.txt\`** in this folder
   (\`./hello > hello.out.txt\` — or whatever you named the binary — then \`cat hello.out.txt\`). That file
   is how NovaClaw checks afterwards that the program really compiled and really ran.

Finish by stating the compiler used, the exact build command, and the program's output.

Your shell is **bash**, on every platform — Git Bash on Windows, not \`cmd\`. Use POSIX syntax and forward
slashes. \`if exist\`, \`where /R\`, \`dir /b\` and \`start\` either fail or behave differently than you expect,
and each call starts in this folder afresh, so a \`cd\` in one call does not carry to the next.

Three ways to fail this task that are worth naming, because they are the common ones:
- Reporting "no compiler found" without having tested the paths in 2b. That is a wrong answer, not a
  finding.
- Losing the build output because you \`cd\`-ed somewhere in one command and compiled in another. Compile
  and run in this folder, with plain relative paths.
- Ending your turn to ask what to work on. This prompt IS the task and nobody may be at the keyboard to
  answer you — work through steps 1-4 and only then stop. If a compiler genuinely does not exist, say so
  plainly, leave \`hello.c\` on disk, and do not try to install one.`,
  },
  {
    slug: "pi-100-machin",
    name: "100 digits of Pi (BigInt Machin)",
    description: "Long-horizon exact math: arbitrary-precision arithmetic from scratch, verified digit by digit.",
    // The other half of the pair AGENTS.md calls the install health check, and the more expensive one to
    // discover late: this recipe is deliberately long-horizon, so "no compiler" found at the end costs a
    // lot more model time than "no compiler" found at the door.
    needs: ["a C compiler"],
    produces: ["pi.c", "pi.txt"],
    prompt: `Write a C99 program that prints the first 100 decimal digits of π, then verify it.

Write the program as \`pi.c\` in this folder, and save the digits it prints to \`pi.txt\` — that file is how
NovaClaw checks afterwards that the program really compiled and really ran.

Requirements:
- Use a **Machin-like arctangent formula** (e.g. π/4 = 4·arctan(1/5) − arctan(1/239)).
- Implement **arbitrary-precision integer arithmetic yourself** — fixed-point big integers in a base of
  your choosing. No bignum library, and no floating point in the digit computation.
- **Do not hardcode the digits of π** anywhere, in any form. The program must compute them.
- Carry guard digits so truncation error cannot reach the 100th printed digit, and say in a comment how
  many you used and why that is enough.

Then verify properly: compare your output against a known value of π to 100 places and state **exactly how
many leading digits are correct**. If it is fewer than 100, debug and iterate — do not report success on a
partially-correct result.

Write the program first, then find the compiler: \`cc\`/\`gcc\`/\`clang\` on PATH, and if none are there and you
are on Windows, test \`C:/soft/w64devkit/bin/gcc.exe\`, \`C:/msys64/mingw64/bin/gcc.exe\`,
\`C:/mingw64/bin/gcc.exe\` and \`C:/TDM-GCC-64/bin/gcc.exe\` with one \`ls\` each. Do not wildcard-sweep the
filesystem looking for it. If the compiler is off-PATH, **append** its directory for the build
(\`PATH="$PATH:/c/soft/w64devkit/bin" gcc …\`): a full-path call alone fails with \`cannot execute 'as'\`, and
*prepending* shadows the shell's own \`ls\`/\`head\` with BusyBox and breaks your later commands. Finish with
the digits, the correct-digit count, and the build command.

Note: this one is deliberately hard. Getting the precision analysis right matters more than being fast.
Work through it to the end — this prompt is the whole task, and nobody may be at the keyboard to answer a
question if you stop to ask one.`,
  },
  {
    slug: "browser-os",
    name: "Browser OS",
    description: "A desktop environment in a single HTML file — the big front-end generation test.",
    produces: ["os.html"],
    prompt: `Using HTML, CSS and JavaScript, build a "browser OS" — a desktop environment that runs in a browser.

Write it to \`os.html\` in this folder.

Requirements:
- At least **5 applications**, each in its own window (draggable, focusable, closable).
- **Two of the 5 must be functional 3D** — one a driving/open-world toy, the other your choice.
- Ability to **change the wallpaper**.
- One **"special" feature of your own design** — document what it is and why it is special.

Constraints: a **single self-contained file** that opens directly in a modern browser. No build step, no
external libraries, no network dependency at runtime.

When done, tell me the filename, list the 5 apps in one line each, and explain your special feature. If
anything is a stub rather than working, say which — an honest list beats a claim of five working apps.`,
  },
  {
    slug: "dungeon-crawler",
    name: "Procedural dungeon with fog of war",
    description: "Single-file HTML game: procedural generation, 2D graphics math, and visibility.",
    produces: ["dungeon.html"],
    prompt: `Act as an expert game engineer specialising in retro rogue-like mechanics and 2D graphics math.

Build a complete, self-contained **procedural dungeon generator with dynamic fog of war** in a single,
beautifully styled HTML file called \`dungeon.html\`, in this folder. Vanilla HTML, CSS and JavaScript — no
external libraries.

Requirements:
- **Generation:** rooms connected by corridors, guaranteed reachable — no sealed-off areas. A new seed
  produces a genuinely different map.
- **Fog of war:** unexplored / previously-seen-but-not-visible / currently-visible must be visually
  distinct. Use real line-of-sight from the player's tile, not a radius blob.
- **Movement:** arrow keys and WASD, with wall collision.
- **UI:** dark theme, centred canvas, and a control panel with a regenerate button and a visible seed.

Finish by naming the file, describing your line-of-sight algorithm in two sentences, and stating anything
you left out.`,
  },
  {
    slug: "osint-brief",
    name: "OSINT research brief",
    description: "Evidence-disciplined web research with labelled confidence and cited sources.",
    produces: ["brief.md"],
    prompt: `Research a subject of my choosing on the open web and produce an evidence-backed brief.

**Ask me what to research before you start** if I have not told you — one line is enough.

Method:
- Search in the subject's own language as well as English, using at least three angles: identity,
  relationships, and **contradiction** (denials, corrections, retractions, disputes). The contradiction
  angle is the one people skip; it is where calibration comes from.
- Prefer primary records — official statements, filings, registries, the subject's own published words.
  Treat corporate PR as authoritative about its own position, not as neutral truth.
- **Before you write "Confirmed", name the tool call whose output contains the text you are citing.** A
  source you could not READ is *Inaccessible*, never Confirmed. A search snippet is *Probable* at best,
  and say so: "(search snippet; page inaccessible)".
- Ten outlets repeating one original report is **one** source. Track independent origins and say when a
  widely-repeated figure traces back to a single claim.

Deliver \`brief.md\` with: an executive summary; findings each carrying a label
(Confirmed / Probable / Weak / Contradicted) and a URL; a "Sources I could not read" section with what you
tried; and open questions. Separate FACT from your own INFERENCE — inference is welcome, labelled.

Use public information only. Never bypass a login, paywall or CAPTCHA — if a source refuses, record it as
inaccessible and move on. Name public figures and organisations; describe private individuals by role.`,
  },
  {
    slug: "csv-insight",
    name: "Data file to insight",
    description: "Takes a messy CSV and returns a cleaned dataset plus a chart and honest caveats.",
    produces: ["clean.csv", "chart.html"],
    prompt: `Turn a data file into something I can actually use.

If there is a \`.csv\`, \`.tsv\` or \`.json\` data file in this folder, use it. If there is not, **generate a
deliberately messy sample CSV first** (inconsistent dates, missing cells, a duplicate row, a stray unit
suffix, one mis-typed number) so the cleaning work is real, and say that you did.

Do this:
1. **Profile** it: rows, columns, types, missing-value counts, and anything that looks wrong.
2. **Clean** it into \`clean.csv\` — and keep a short log of every change, with the reason. Never silently
   drop a row.
3. **Chart** the most interesting relationship as a single self-contained \`chart.html\` (no external
   libraries, readable in light and dark).
4. **Report** 3–5 findings, each with the number behind it.

Then add a **caveats** section: what the data cannot tell me, what you had to assume, and which findings
would change if your assumptions were wrong. A confident conclusion from 12 rows is worse than no
conclusion — say so if that is the situation.`,
  },
] as const

export const BUILTIN_SLUGS: ReadonlySet<string> = new Set(BUILTINS.map((recipe) => recipe.slug))

// =============================================================================
// The `examples` COLLECTION — where a recipe lives, decided by the build
// =============================================================================
//
// Owner decision (`notes/reports/decisions-v0.2.0.md` → *Referred to the owner*, answered 2026-07-27):
// *"The bundled set keeps its seven, and moves under an `examples/` collection — recipes gain a collection
// so a user's own recipes, shipped examples, and a possible later curated tier are visibly distinct. The
// `builtin` boolean cannot express that and cannot group. This does not touch ruling 14: a collection is
// WHERE A RECIPE LIVES, not what it is granted."*
//
// The array above IS that collection's membership, and `BUILTIN_SLUGS` is its index. What follows is the
// vocabulary — because the boolean answers *"did we ship it?"* and a collection has to answer *"which
// shelf is it on?"*, which is a different question the moment there are three shelves.
//
// ── ⚠️ THE NAME COLLISION THIS ITEM WAS OPENED AGAINST, stated plainly ────────────────────────────────
//
// The brief: *define the bundled `examples/` registry **without confusing recipes with Spark
// runtime profiles***. That is not a stylistic worry — ruling 14's rules_out list ends with *"two things
// called 'recipe' in one agent's context"*, and both things exist here already:
//
//   · **A NovaClaw recipe** is a FOLDER of prose. It states INTENT, may declare `needs` and `produces`,
//     and may never carry configuration or anything that runs (ruling 14). Nothing in it is executed.
//   · **A Spark runtime profile** is a `sparkrun` YAML — and sparkrun is literally *"a community
//     recipe-runner"* invoked as `sparkrun run <recipe.yaml>`, whose files live in `~/recipes/` on the
//     Spark (`doc/spark.md`, `notes/ops/test-models-maintenance.md`, `notes/ops/sparkrun-*.yaml`). It
//     carries `runtime:`, `container:`, `model:`, `env:`, `solo_only:`, `recipe_version:` and a
//     `command:` template that is EXECUTED verbatim on a GPU host, plus a `defaults:` table of ports,
//     `max_model_len` and `gpu_memory_utilization`.
//
// So the two concepts share a noun AND a verb — `sparkrun run <recipe>` next to `recipe.run` — while one
// of them is a shell command with a resource budget and the other may not contain either.
//
// ⭐ **Why defining a REGISTRY is the exact moment the collision bites.** A registry of bundled entries is
// precisely what `~/recipes/` is, and sparkrun's is the ready-made template an agent with both in context
// will reach for: a directory of versioned entries, each a `name` plus a `defaults:` table plus a
// `command:`. Adopting one field of that shape — a `defaults:` block, an `env:`, a `port`, a
// `recipe_version` — puts configuration and an executable into a recipe, which is ruling 14's
// `permissionMode`-in-frontmatter with a different label on it. The distinction is therefore load-bearing
// and not tidiness, and it is armed by a test rather than by this paragraph:
// `test/recipe-collection.test.ts` fails if any bundled entry ever grows a runtime-profile field name.
//
// The two are kept plainly distinct by three properties, all mechanical:
//   1. a bundled entry is a `Recipe.SaveInput` and nothing else — prose, `needs`, `produces`, no other
//      field exists to put a knob in;
//   2. a collection has an id and a title and NO settings — it is a shelf, not a profile;
//   3. nothing in this module or `recipe.ts` executes, spawns, or reads an env var.
//
// ── WHY MEMBERSHIP IS DERIVED, and not declared or inferred from a folder ─────────────────────────────
//
// A collection is a **provenance** fact: *NovaClaw shipped this one.* Two tempting homes are both wrong:
//
//   · **A `collection:` frontmatter key.** A recipe is untrusted input the moment it lands (ruling 14), so
//     a self-declared collection lets a stranger's zip announce itself as a NovaClaw example. `tool/
//     recipe.ts` already draws this line for the sibling field: *"a shared recipe's self-declared expertise
//     level is untrusted input, so the artifact may propose and the instance decides."* Provenance is the
//     case where there is nothing to propose.
//   · **A `recipes/examples/` DIRECTORY on disk.** It reads like the literal answer to "where a recipe
//     lives", and it is exactly as forgeable — unzipping a shared folder into it grants the same false
//     provenance, with no untrusted *file* required. It would also mean migrating folders that are already
//     on users' disks, and those folders are theirs (see the seeding note in this module's header).
//
// What is left is the only teller that cannot be forged from outside: the BUILD. `BUILTIN_SLUGS` is a
// module constant compiled into the bundle, so membership is a fact about this NovaClaw, decided before
// any user or peer could touch it. A user may still edit or delete an example — they own the bytes once it
// is on their disk — and it stays on the Examples shelf, which is correct: it is still the recipe we
// shipped, now with their changes.
//
// ── IS THIS THE `needs`/`collection`/`level` SCHEMA BATCH? NO, and that is the finding ────────────────
//
// The sequencing is *"one schema change, not two (three, counting the level)"* — `needs`,
// `collection` and `level` promoted together, with a `packages/protocol` field to make them wire-visible.
// The reasoning above removes `collection` from that batch entirely: it is not a frontmatter field at all,
// so it has nothing to promote and cannot ride along. The batch is `needs` and `level`, both still
// unlanded, both still artifact-declared. Nothing here adds a carried field, changes `parse`/`render`, or
// touches `Recipe`'s key set — which `test/tool-recipe.test.ts` pins EXACTLY, and which pins `collection`
// itself in its FORBIDDEN list precisely because an artifact-declared one is the thing to keep out.

/** The shelves a recipe can be on. Closed, and every member is decided by the instance, never by the file. */
export type Collection = "examples" | "mine"

export interface CollectionInfo {
  readonly id: Collection
  /** What a person reads above the group. */
  readonly title: string
  /** One line the UI may show, in house style: say what the shelf IS, do not explain the mechanism. */
  readonly note: string
}

/**
 * In display order: what the install brought, then what the user made.
 *
 * ⚠️ **No settings, no defaults, no command, no version** — a collection is a shelf. That is the whole of
 * the distinction from a Spark runtime profile at the type level, and the reason a third tier is three
 * lines of work rather than a schema: add its `CollectionInfo`, add its registry, add its arm to
 * {@link collectionOf}. A tier with no members is NOT added ahead of time — an empty shelf in the UI is a
 * promise the product has not kept.
 */
export const COLLECTIONS: readonly CollectionInfo[] = [
  {
    id: "examples",
    title: "Examples",
    note: "Recipes NovaClaw brought with it. Run one to see what this install can do — or copy one and make it yours.",
  },
  { id: "mine", title: "My recipes", note: "Everything you wrote, imported, or copied." },
]

export const collectionInfo = (id: Collection): CollectionInfo =>
  COLLECTIONS.find((collection) => collection.id === id) ?? COLLECTIONS[COLLECTIONS.length - 1]

/**
 * Which shelf a slug is on. Reads `BUILTIN_SLUGS` — the build's own record of what it shipped — rather
 * than the record's `builtin` flag, which is only as good as the `builtinSlugs` its caller remembered to
 * pass, and rather than anything the file says about itself.
 */
export const collectionOf = (slug: string): Collection => (BUILTIN_SLUGS.has(slug) ? "examples" : "mine")

/**
 * Write any missing builtin into the recipes folder. Idempotent and NON-destructive: a slug that already
 * exists is left alone, so a user's edits to a shipped recipe survive every upgrade — they own it once it
 * is on their disk. A single failure never blocks the rest (or startup).
 */
export async function seed(options?: Recipe.Options): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = []
  const skipped: string[] = []
  for (const builtin of BUILTINS) {
    const existing = await Recipe.read(builtin.slug, options).catch(() => undefined)
    if (existing) {
      skipped.push(builtin.slug)
      continue
    }
    const saved = await Recipe.save({ ...builtin, builtin: true }, options).catch(() => undefined)
    if (saved) created.push(builtin.slug)
  }
  return { created, skipped }
}
