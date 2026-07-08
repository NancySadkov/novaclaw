import { Slug } from "@novaclaw/core/util/slug"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

// F1f: the project-copy name suggestion is a deterministic slug derived from the copy context.
// The V1 small-model name-gen (LLM.stream) was retired with the V1 engine — a session-less LLM call
// needs full native model + credential resolution inside an HTTP handler, which is not worth it for
// a peripheral utility (vision call: simplest codebase over a minor nicety). Users rename after copy.
export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.succeed(
    handlers.handle("generateName", (ctx) => {
      const text = ctx.payload.context?.trim()
      const fromContext = text ? slugify(text.split(/\s+/).slice(0, 3).join(" ")) : ""
      return Effect.succeed({ name: fromContext || Slug.create() })
    }),
  ),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
