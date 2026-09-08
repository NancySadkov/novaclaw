import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandV2 } from "@novaclaw/core/command"
import { Credential } from "@novaclaw/core/credential"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FileSystem } from "@novaclaw/core/filesystem"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Integration } from "@novaclaw/core/integration"
import { Location } from "@novaclaw/core/location"
import { Npm } from "@novaclaw/core/npm"
import { PluginV2 } from "@novaclaw/core/plugin"
import { Reference } from "@novaclaw/core/reference"
import { SkillV2 } from "@novaclaw/core/skill"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    Catalog.node,
    CatalogStore.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
    PluginTools.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
