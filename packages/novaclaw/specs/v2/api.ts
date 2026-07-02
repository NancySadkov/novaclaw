// @ts-nocheck

import { NovaClaw } from "@novaclaw/core"
import { ReadTool } from "@novaclaw/core/tools"

const novaclaw = NovaClaw.make({})

novaclaw.tool.add(ReadTool)

novaclaw.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

novaclaw.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

novaclaw.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await novaclaw.session.create({
  agent: "build",
})

novaclaw.subscribe((event) => {
  console.log(event)
})

await novaclaw.session.prompt({
  sessionID,
  text: "hey what is up",
})

await novaclaw.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await novaclaw.session.wait()

console.log(await novaclaw.session.messages(sessionID))
