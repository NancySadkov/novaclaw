import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "capability-stdio-fixture", version: "1" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "document.parse.native",
      inputSchema: {
        type: "object",
        properties: { handle: { type: "string" } },
        required: ["handle"],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.arguments?.crash === true) {
    setTimeout(() => process.exit(23), 0)
    return new Promise<never>(() => {})
  }
  return { content: [{ type: "text", text: String(request.params.arguments?.handle ?? "") }] }
})

await server.connect(new StdioServerTransport())
