import { probeLiveCompatibility } from "../src/lib/ai/live-compat.js";
import { createDefaultAdapters } from "../src/lib/ai/adapters.js";

const ping = process.argv.includes("--ping");
const adapters = createDefaultAdapters({
	get: async () => null,
	set: async () => "session",
	delete: async () => undefined,
});

const report = await probeLiveCompatibility(adapters, { ping });
console.log(JSON.stringify(report, null, 2));
