import { createRequire } from "node:module";
import * as path from "node:path";

const installedElectronPath: unknown = createRequire(path.join(process.cwd(), "package.json"))("electron");

export function electronExecutablePath(): string {
  if (typeof installedElectronPath !== "string" || installedElectronPath.length === 0) {
    throw new TypeError("The installed electron package did not resolve to an executable path");
  }
  return installedElectronPath;
}
