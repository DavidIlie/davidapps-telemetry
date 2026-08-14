#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, readPackages } from "./package-catalog.mjs";

const version = process.argv[2];
assert(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ""),
  "usage: pnpm release:version <semver> (for example: pnpm release:version 0.1.1)",
);

const packages = await readPackages();
for (const package_ of packages) {
  const path = new URL("package.json", package_.path);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`${manifest.name} -> ${version}`);
}

console.log("Next: pnpm install --lockfile-only && pnpm release:verify");
console.log(`After committing, create tag v${version} on that exact commit; the tag starts publishing.`);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error("set-release-version.mjs must be run as a script");
}
