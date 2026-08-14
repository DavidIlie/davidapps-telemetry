import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const upstream = await readFile(new URL("UPSTREAM.yml", root), "utf8");
const rootLicense = await readFile(new URL("LICENSE", root), "utf8");

if (upstream.includes("commit: pending")) {
  throw new Error("UPSTREAM.yml contains an unpinned source commit");
}

const packageDirectories = await readdir(new URL("packages/", root), { withFileTypes: true });
for (const directory of packageDirectories) {
  if (!directory.isDirectory()) continue;
  const packageJson = JSON.parse(
    await readFile(new URL(`packages/${directory.name}/package.json`, root), "utf8"),
  );
  if (!packageJson.license) throw new Error(`${packageJson.name} has no license`);
  const packageLicense = await readFile(
    new URL(`packages/${directory.name}/LICENSE`, root),
    "utf8",
  );
  if (packageLicense !== rootLicense) {
    throw new Error(`${packageJson.name} LICENSE is not synchronized with the root license`);
  }
}

const licenseFiles = await readdir(new URL("licenses/", root));
if (licenseFiles.length === 0) throw new Error("licenses/ is empty");

console.log(`Verified ${packageDirectories.length} packages and ${licenseFiles.length} license files.`);
