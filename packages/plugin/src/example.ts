import { Plugin } from "./index.js"

// The live server-plugin surface: durable-event fan-out, config, shell env, auth methods.
// (Model-facing custom TOOLS are a V2-plugin feature — see ./v2 and `ctx.tool.register`.)
export const ExamplePlugin: Plugin = async (_ctx) => {
  return {
    async event({ event }) {
      if (event.type === "session.created") console.log("session created", event.properties)
    },
    "shell.env": async (_input, output) => {
      output.env["EXAMPLE_PLUGIN"] = "1"
    },
  }
}
