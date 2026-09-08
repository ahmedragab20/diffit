import { probeLiveCompatibility } from "../src/lib/ai/live-compat.js";
import { createDefaultAdapters } from "../src/lib/ai/adapters.js";
import { SystemSecretStore } from "../src/lib/ai/secrets.js";

const ping = process.argv.includes("--ping");
const adapters = createDefaultAdapters(new SystemSecretStore());

const report = await probeLiveCompatibility(adapters, { ping });
console.log(JSON.stringify(report, null, 2));
