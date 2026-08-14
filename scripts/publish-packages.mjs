#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, parseArguments } from "./package-catalog.mjs";

function npm(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("npm", arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`npm ${arguments_.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result;
}

async function fileIntegrity(path) {
  const contents = await readFile(path);
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

function publishedIntegrity(name, version, registry) {
  const result = npm(
    ["view", `${name}@${version}`, "dist.integrity", "--json", "--registry", registry],
    { allowFailure: true },
  );
  if (result.status === 0) return { state: "published", integrity: JSON.parse(result.stdout) };

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/\bE404\b|404 Not Found/i.test(output)) return { state: "missing" };
  throw new Error(`could not inspect ${name}@${version}\n${output}`);
}

async function waitForIntegrity(package_, registry) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const remote = publishedIntegrity(package_.name, package_.version, registry);
    if (remote.state === "published" && remote.integrity === package_.integrity) return;
    if (attempt < 6) await new Promise((resolve_) => setTimeout(resolve_, attempt * 2_000));
  }
  throw new Error(`${package_.name}@${package_.version} was published but its integrity is not visible`);
}

export async function publishPackages({ manifestPath, registry, checkOnly = false }) {
  const absoluteManifest = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  assert(manifest.schemaVersion === 1, `unsupported package manifest schema: ${manifest.schemaVersion}`);
  assert(Array.isArray(manifest.packages) && manifest.packages.length > 0, "package manifest is empty");
  const packageRoot = dirname(absoluteManifest);

  for (const package_ of manifest.packages) {
    assert(package_.version === manifest.version, `${package_.name}: manifest version mismatch`);
    const local = await fileIntegrity(resolve(packageRoot, package_.filename));
    assert(local === package_.integrity, `${package_.name}: tarball integrity changed after packing`);
  }

  // Resolve every remote state before the first mutation. A conflict in package
  // five must never be discovered after packages one through four were published.
  const plan = manifest.packages.map((package_) => {
    const remote = publishedIntegrity(package_.name, package_.version, registry);
    if (remote.state === "published") {
      assert(
        remote.integrity === package_.integrity,
        `${package_.name}@${package_.version} already exists with different integrity`,
      );
      return { package_, action: "skip" };
    }
    return { package_, action: "publish" };
  });

  console.log("Registry preflight complete:");
  for (const item of plan) console.log(`- ${item.action}: ${item.package_.name}@${item.package_.version}`);
  if (checkOnly) {
    console.log("Check-only mode: registry state is safe to publish; no packages were changed.");
    return;
  }

  for (const { package_, action } of plan) {
    if (action === "skip") continue;
    npm([
      "publish",
      resolve(packageRoot, package_.filename),
      "--access",
      "public",
      "--provenance",
      "--registry",
      registry,
    ]);
    await waitForIntegrity(package_, registry);
  }

  console.log(`Published or verified ${plan.length} packages at ${manifest.version}.`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  assert(args.manifest, "missing --manifest");
  await publishPackages({
    manifestPath: args.manifest,
    registry: args.registry ?? "https://registry.npmjs.org/",
    checkOnly: args["check-only"] === "true",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`package publishing failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
