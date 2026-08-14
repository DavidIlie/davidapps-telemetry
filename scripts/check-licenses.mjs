import { readFile, readdir } from "node:fs/promises";
import "./check-upstream.mjs";

const root = new URL("../", import.meta.url);
const upstream = await readFile(new URL("UPSTREAM.yml", root), "utf8");
const rootLicense = await readFile(new URL("LICENSE", root), "utf8");
const rootNotices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");

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
  const packageNotices = await readFile(
    new URL(`packages/${directory.name}/THIRD_PARTY_NOTICES.md`, root),
    "utf8",
  );
  if (packageNotices !== rootNotices) {
    throw new Error(
      `${packageJson.name} THIRD_PARTY_NOTICES.md is not synchronized with the root notice`,
    );
  }
  const packageUpstream = await readFile(
    new URL(`packages/${directory.name}/UPSTREAM.yml`, root),
    "utf8",
  );
  if (packageUpstream !== upstream) {
    throw new Error(`${packageJson.name} UPSTREAM.yml is not synchronized with the root registry`);
  }
  const shippedFiles = new Set(packageJson.files ?? []);
  for (const required of ["LICENSE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.yml"]) {
    if (!shippedFiles.has(required)) {
      throw new Error(`${packageJson.name} does not ship ${required}`);
    }
  }
}

const licenseFiles = await readdir(new URL("licenses/", root));
if (licenseFiles.length === 0) throw new Error("licenses/ is empty");

console.log(
  `Verified ${packageDirectories.length} packages, synchronized notices, and ${licenseFiles.length} license files.`,
);
