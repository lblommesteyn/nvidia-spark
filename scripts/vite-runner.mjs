import { resolve } from "node:path";
import { runNodeScript } from "./node-runner.mjs";

runNodeScript(resolve("node_modules/vite/bin/vite.js"), process.argv.slice(2));
