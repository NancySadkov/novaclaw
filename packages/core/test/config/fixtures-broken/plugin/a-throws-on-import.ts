// A plugin that fails at MODULE SCOPE — the fault shape that arrives as a defect out of `import()`,
// before `Effect.tryPromise` can type it. Named `a-…` so the loader's sorted walk reaches it first
// and the good plugin behind it proves one broken plugin does not stop the others.
throw new Error("this plugin throws while being imported")
