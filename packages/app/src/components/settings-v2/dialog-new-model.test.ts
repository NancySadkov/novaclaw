import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ConfigLocalRuntime } from "@novaclaw/core/config/local-runtime"
import { dict as en } from "@/i18n/en"
import { providerIDFromEndpoint } from "./dialog-new-model"

// S0 — the Add-models dialog's half of the local-runtime probe (`todo/sidecar-inference.md` →
// *Slice 0*). The classifier itself is pinned in `packages/core/test/config-local-runtime.test.ts`;
// what is left over here is the WIRING, and every one of these renders identically when it is wrong:
//
//   · a sweep hoisted to module scope, or to app boot, is a startup cost on every launch — and it
//     looks exactly like a sweep that runs when the dialog opens;
//   · a Resource created while dialog.push() is committing can suspend the whole dialog until a
//     stalled instance answers, so discovery starts only after the usable dialog has mounted;
//   · rendering `outcomes` instead of `adoptable` puts `unidentified` ports on screen as found
//     runtimes, which is ruling 2 (*a fault is never described falsely*) with a friendly face;
//   · binding the "couldn't check" line to an empty list instead of to `ran === false` collapses
//     "we could not look" into "nothing is there" — the same ruling, the other direction;
//   · a translation key that is not in `en.ts` renders as raw dotted text at a user. `tsgo` catches
//     that, and the day-to-day gate runs `tsgo` — but the key set is the thing this file is about,
//     so it is asserted here too rather than assumed.
//
// Asserted against the SOURCE, following `dialog-select-model.test.ts`: these are all decisions that
// a DOM render would only reveal against a live instance with a live Ollama, which is exactly the
// setup no CI machine has.

const HERE = import.meta.dir
const dialog = fs.readFileSync(path.join(HERE, "dialog-new-model.tsx"), "utf8")

/**
 * The same file with comments removed. Every NEGATIVE assertion below runs against this: the
 * comments in that dialog explain S0 and therefore quote the very things the negatives forbid — the
 * first draft of this test failed on its own explanation of why `localhost:11434` must not be
 * fetched from the browser. A negative check that a doc comment can trip is a check that gets
 * deleted the first time someone writes a good comment.
 */
const code = dialog.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

describe("Add-models — the local-runtime probe wiring", () => {
  test("the sweep runs on dialog open, not at import and not at boot", () => {
    // `onMount` = one sweep per dialog open, after the Custom endpoint card is already usable. A
    // top-level call would fire when the chunk is imported; createResource here used to suspend the
    // transition that was trying to put the dialog on screen.
    expect(dialog).toContain("ConfigLocalRuntime.sweep({")
    const sweepAt = dialog.indexOf("ConfigLocalRuntime.sweep({")
    const componentAt = dialog.indexOf("export const DialogNewModel")
    expect(sweepAt).toBeGreaterThan(componentAt)
    expect(dialog).toMatch(/onMount\(\(\) => \{[\s\S]{0,1200}ConfigLocalRuntime\.sweep\(\{/)
    expect(code).not.toContain("createResource")
    expect(dialog).toContain("onCleanup(() => abort.abort())")
    // No interval: the external-runtime sweep remains one-shot. The managed install arm separately
    // uses a bounded timeout chain while a real background job is running.
    expect(code).not.toContain("setInterval")
  })

  test("the probe goes through the server-side endpoint, never a browser fetch to localhost", () => {
    // The instance may be on another machine (AGENTS.md → P2P instances). A `fetch("http://localhost…")`
    // here would probe the browser's box instead of the one that serves the turn.
    expect(dialog).toMatch(/probe: \(localCandidate\) =>\s*\n?\s*providerProbe\(props\.http, \{/)
    expect(code).not.toMatch(/fetch\(/)
    // And no candidate URL is authored here — the port list lives in core, behind the loopback guard.
    expect(code).not.toMatch(/11434|:1234|:8080|http:\/\/localhost/)
  })

  test("only ADOPTABLE outcomes reach the screen — an unidentified port is never offered", () => {
    expect(dialog).toContain("ConfigLocalRuntime.excludeConfigured(result.adoptable, configuredURLs())")
    // `.outcomes` carries `unidentified` / `absent` / `unknown`; rendering it would announce a random
    // web server on :8000 as a model runtime.
    expect(code).not.toContain(".outcomes")
  })

  test("'couldn't check' is bound to ran===false, not to an empty result", () => {
    expect(dialog).toMatch(
      /localUnavailable = \(\) => \{[\s\S]{0,120}const result = localSweep\(\)[\s\S]{0,100}!result\.ran/,
    )
    expect(dialog).toMatch(/<Show when=\{localUnavailable\(\)\}>[\s\S]{0,200}settings\.models\.new\.local\.unavailable/)
  })

  test("the card asserts the ADDRESS and only hints at the runtime", () => {
    // Ruling 2: we verified a `/v1/models` answer on a port, not the identity of the program that
    // answered. The heading is the endpoint; the vendor name is the `usually` hint underneath.
    expect(dialog).toContain("{`localhost:${outcome.candidate.port}`}")
    expect(dialog).toMatch(/settings\.models\.new\.local\.usually", \{ runtime: outcome\.candidate\.usually \}/)
  })

  test("the sweep probes under a FREE provider id — probing under a taken one leaks its API key", () => {
    // 🔴 `POST /provider/:providerID/probe` falls back to the saved provider's
    // `request.body.apiKey` when the payload has none. Probing as a bare `"ollama"` on an instance
    // that already has a provider called `ollama` (holding a paid API's key) would Bearer that key
    // to whatever program is listening on loopback :11434. This is the check that it cannot happen.
    expect(dialog).toContain("providerID: freeProviderID(localCandidate.id)")
    expect(code).not.toMatch(/providerID: localCandidate\.id/)
    expect(dialog).toContain("ConfigLocalRuntime.uniqueProviderID(base, Object.keys(config().providers ?? {}))")
    // …and the same resolution is what gets adopted, so the id shown is the id that was tested.
    expect(dialog).toContain("providerID: freeProviderID(found.id)")
    // The probe payload carries no apiKey of its own either — nothing to leak in the first place.
    expect(code).not.toMatch(/probe: \(localCandidate\)[\s\S]{0,400}apiKey/)
  })

  test("every translation key this dialog uses exists in en.ts", () => {
    const keys = [...dialog.matchAll(/t\(\s*"([a-zA-Z0-9_.]+)"/g)].map((match) => match[1]!)
    expect(keys.length).toBeGreaterThan(10)
    const missing = [...new Set(keys)].filter((key) => !(key in en))
    expect(missing).toEqual([])
    // The S0 strings specifically — a probe that finds something and then renders a raw dotted key is
    // worse than one that finds nothing.
    for (const key of ["checking", "title", "models", "needsKey", "usually", "unavailable"])
      expect(`settings.models.new.local.${key}` in en, key).toBe(true)
  })
})

describe("Add-models — the module the dialog imports is browser-safe", () => {
  test("`@novaclaw/core/config/local-runtime` loads under the app's conditions and pulls no node builtins", () => {
    // It is imported into the renderer bundle. `provider-preset.ts` (its neighbour) drags in `effect`,
    // and `offline.ts` — whose loopback rule this module restates — drags in `fs`/`path`/sqlite. This
    // test failing means the sweep would break the web build rather than a test.
    expect(typeof ConfigLocalRuntime.sweep).toBe("function")
    const source = fs.readFileSync(
      path.join(HERE, "..", "..", "..", "..", "core", "src", "config", "local-runtime.ts"),
      "utf8",
    )
    expect(source).not.toMatch(/^import .*/m)
  })
})

describe("Add-models — safe limits for discovered models", () => {
  test("persists each model's advertised limits and falls back field by field", () => {
    expect(dialog).toContain("const limits = input.limits[id]")
    expect(dialog).toContain("context: limits?.context ?? ModelV2.DEFAULT_LIMIT.context")
    expect(dialog).toContain("output: limits?.output ?? ModelV2.DEFAULT_LIMIT.output")
    expect(dialog).not.toContain("context: result()?.window")
  })

  test("tells the user when either limit was not reported", () => {
    expect(dialog).toContain('t("settings.models.new.limits.contextOnly"')
    expect(dialog).toContain('t("settings.models.new.limits.outputOnly"')
    expect(dialog).toContain('t("settings.models.new.limits.unknown"')
    expect(dialog).toContain("{limitDescription(id)}")
  })
})

describe("Add-models — endpoint identity", () => {
  test("generates hidden config keys from serving URLs", () => {
    expect(providerIDFromEndpoint("https://llm.example:8443/v1/")).toBe("llm-example-8443-v1")
    expect(providerIDFromEndpoint("http://localhost:8080/v1")).toBe("localhost-8080-v1")
  })

  test("asks for the endpoint, not internal ids or premature display names", () => {
    expect(code).not.toContain('<Field field="providerID"')
    expect(code).not.toContain('<Field field="name"')
    expect(dialog).toContain("name: saved()?.name?.trim() || form.baseURL.trim()")
    expect(dialog).toContain('name: "local"')
  })
})

describe("Add-models — managed local model", () => {
  test("is a first-class Local Model choice, not a terminal instruction", () => {
    expect(dialog).toContain('data-action="new-model-local"')
    expect(dialog).toContain('setStep("local")')
    expect(dialog).toContain("localModelInstall(props.http")
    expect(dialog).not.toMatch(/powershell|llama-server\.exe|huggingface\.co/)
  })

  test("keeps the user informed while the instance-owned job runs", () => {
    expect(dialog).toContain("status().message")
    expect(dialog).toContain("status().detail")
    expect(dialog).toContain("status().preflight?.issues")
    expect(dialog).toContain("progress()")
    expect(dialog).toContain("localModelStatus(props.http")
    expect(dialog).toContain("if (!managed()) void refreshManaged()")
    expect(dialog).toContain('error() ?? t("settings.models.new.managed.checking")')
    expect(dialog).toContain(
      "if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))",
    )
  })

  test("registers the installed model without requiring the sidecar to stay loaded", () => {
    expect(dialog).toContain('status.stage === "installed" || status.stage === "ready"')
    expect(dialog).toContain('freeProviderID("local")')
    expect(dialog).toContain("baseURL: status.baseURL")
    expect(dialog).toContain("[status.modelID]: { context: status.context, output: status.output }")
    expect(dialog).toContain("serverSync().updateConfig")
  })
})
