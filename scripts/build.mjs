import { resolve } from "node:path";
import { runNodeScript, systemNode } from "./node-runner.mjs";
import { spawnSync } from "node:child_process";

const tsc = resolve("node_modules/typescript/bin/tsc");
const vite = resolve("node_modules/vite/bin/vite.js");

const typecheck = spawnSync(systemNode, [tsc, "--noEmit"], {
  stdio: "inherit",
  shell: false,
});

if (typecheck.error) {
  throw typecheck.error;
}

if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

runNodeScript(vite, ["build"]);
