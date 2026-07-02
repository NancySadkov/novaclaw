import path from "path"

process.env.NOVACLAW_DB = ":memory:"
process.env.NOVACLAW_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.NOVACLAW_DISABLE_MODELS_FETCH = "true"
