import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const systemNode =
  process.platform === "win32" && existsSync("C:\\Program Files\\nodejs\\node.exe")
    ? "C:\\Program Files\\nodejs\\node.exe"
    : process.execPath;

export function runNodeScript(scriptPath, args = []) {
  const result = spawnSync(systemNode, [scriptPath, ...args], {
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}
