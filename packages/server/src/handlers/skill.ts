import { SkillV2 } from "@novaclaw/core/skill"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SkillApi, handlerLayer } from "../handler-api"
import { response } from "../location"

export const SkillHandler = handlerLayer(
  HttpApiBuilder.group(SkillApi, "server.skill", (handlers) =>
    handlers.handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list()))),
  ),
)
