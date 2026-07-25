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
    prompt: `Check whether this NovaClaw installation is working, then report a short verdict table.

Test each capability once, in this order, and keep it quick — no deep work:

1. **Shell** — run a trivial command (print the working directory).
2. **Write a file** — create \`health.txt\` here containing the current date, then read it back.
3. **Toolchain** — find out which of these exist on PATH and report versions: a C compiler
   (\`cc\`, \`gcc\`, \`clang\`), \`python3\`/\`python\`, \`node\`, \`git\`. Do not install anything.
4. **Web search** — search for one current fact and report whether results came back.
5. **Web fetch** — fetch one page you found and report whether you got real text (not an empty shell).

Then write a table with a row per capability: WORKING / NOT WORKING / NOT AVAILABLE, plus one short note
each. End with a single sentence: is this install healthy enough to run the other recipes?

Be honest — a NOT WORKING row is the useful output here, not a failure. Do not fix anything and do not
install anything; just report.`,
  },
  {
    slug: "hello-c",
    name: "Hello, C",
    description: "Compiles and runs a C99 program — the toolchain smoke test.",
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
4. Run the binary and show its actual output.

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
    prompt: `Write a C99 program that prints the first 100 decimal digits of π, then verify it.

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
    prompt: `Using HTML, CSS and JavaScript, build a "browser OS" — a desktop environment that runs in a browser.

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
    prompt: `Act as an expert game engineer specialising in retro rogue-like mechanics and 2D graphics math.

Build a complete, self-contained **procedural dungeon generator with dynamic fog of war** in a single,
beautifully styled HTML file. Vanilla HTML, CSS and JavaScript — no external libraries.

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
