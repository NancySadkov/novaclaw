import { Location } from "@novaclaw/core/location"
import { QualityDetect } from "@novaclaw/core/session/runner/quality-detect"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { handlerLayer, QualityApi } from "../handler-api"
import { response } from "../location"

/**
 * Settings → Quality's "Detect from this project", answered by the SAME scan the
 * `quality_provision` tool runs — `QualityDetect.detect`, which both call and neither copies.
 *
 * ⚠️ It proposes and stops. The tool goes on to verify each candidate by running it once and then
 * writes the result; this route does neither, because a settings button is not a licence to execute
 * five commands on someone's machine, and the person reading the filled boxes is the review.
 */
export const QualityHandler = handlerLayer(
  HttpApiBuilder.group(QualityApi, "server.quality", (handlers) =>
    handlers.handle(
      "quality.detect",
      Effect.fn("v2.quality.detect")(function* () {
        return yield* response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            const proposal = yield* QualityDetect.detect(location.directory)
            return { commands: proposal.commands, evidence: proposal.evidence }
          }),
        )
      }),
    ),
  ),
)
