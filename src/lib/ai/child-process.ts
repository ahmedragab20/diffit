/**
 * Local seam for spawning provider processes. Vite externalizes `node:*`, so a
 * `vi.mock("node:child_process")` in a test never reaches the modules that
 * import it; tests substitute `spawn` by mocking this module instead.
 */
export { spawn } from "node:child_process";
