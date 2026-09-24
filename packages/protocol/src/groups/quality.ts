import { Location } from "@novaclaw/schema/location"
import { Quality } from "@novaclaw/schema/quality"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

/**
 * **Ask the product what this project's quality commands are.**
 *
 * `quality_provision` and Officer Settings → Quality use the same project manifest scan to
 * propose typecheck, test and lint commands.
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
