// @vitest-environment node
import { describe, expect, it } from "vitest";
import { build } from "vite";
import { browserOnlyPlugin } from "../../vite.config";

describe("browser bundle boundary", () => {
  it.each(["node:util", "child_process"])(
    "rejects %s before it becomes an empty browser shim",
    async (module) => {
      await expect(
        build({
          configFile: false,
          logLevel: "silent",
          plugins: [
            browserOnlyPlugin(),
            {
              name: "test-browser-entry",
              resolveId: (id) => id === "virtual:entry" ? "\0virtual:entry" : null,
              load: (id) => id === "\0virtual:entry"
                ? `import * as server from ${JSON.stringify(module)}; console.log(server);`
                : null,
            },
          ],
          build: {
            write: false,
            rolldownOptions: { input: "virtual:entry" },
          },
        }),
      ).rejects.toThrow(`Node-only module "${module}"`);
    },
  );
});
