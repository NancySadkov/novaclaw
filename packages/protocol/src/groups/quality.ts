import { Location } from "@novaclaw/schema/location"
import { Quality } from "@novaclaw/schema/quality"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

/**
 * **Ask the product what this project's quality commands are.**
 *
 * 🔴 The scan already existed and only the model could reach it. `quality_provision` reads the
 * project's own manifests and proposes typecheck/test/lint commands; Settings → Quality, whose
 * header calls itself *"where you review/override what QE-A wrote"*, had five free-text boxes whose
 * only guidance was five hardcoded strings (`bun build --no-bundle {file}`, `tsc -b --noEmit`, …)
 * that are right for this repo and arbitrary for anyone else's. A Python or Rust user was shown
 * TypeScript incantations as the model of what to type, with no way to ask the product what THEIR
 * project uses — while the product could answer, and did, for the model. Principle 12(b): a
 * list-shaped setting offers its list, and this one had to be computed to be offered.
 *
 * ⚠️ Rung 0 ONLY: it reads manifests and proposes. It does not verify (that spawns a process per
 * candidate) and it does not write. A button that fills five boxes must not run five commands on
 * someone's machine uninvited, and the boxes stay the override.
 */
export const QualityGroup = HttpApiGroup.make("server.quality")
  .add(
    HttpApiEndpoint.get("quality.detect", "/api/quality/detect", {
      query: LocationQuery,
      success: Location.response(Quality.Detection),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.quality.detect",
          summary: "Detect quality commands",
          description:
            "Scan the location's own manifests and propose check, typecheck, test and lint commands, with the evidence for each. Proposes only: nothing is run and nothing is saved.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "quality",
      description: "Quality-command detection for a location.",
    }),
  )
