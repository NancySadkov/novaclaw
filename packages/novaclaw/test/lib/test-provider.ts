// Shared provider config for tests that need novaclaw to talk to a fake LLM
// over a real HTTP endpoint. Registers a single provider `test` with a single
// model `test-model` (i.e. `--model test/test-model`), pointed at the URL the
// caller supplies (typically a TestLLMServer instance).
//
// V2 config shape (F1-config: config is authored directly as V2 and unknown
// top-level keys are REJECTED — the old V1 `provider` key made every consumer
// of this fixture fail with "Configuration is invalid").
//
// Used by:
//   - test/lib/cli-process.ts          (subprocess CLI tests)
//   - test/server/httpapi-sdk.test.ts  (in-process SDK tests)
export function testProviderConfig(llmUrl: string) {
  return {
    formatter: false,
    providers: {
      test: {
        name: "Test",
        api: {
          type: "aisdk" as const,
          package: "@ai-sdk/openai-compatible",
          url: llmUrl,
          settings: {},
        },
        request: {},
        models: {
          "test-model": {
            name: "Test Model",
            capabilities: {
              tools: true,
              input: ["text"],
              output: ["text"],
            },
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    },
  }
}
