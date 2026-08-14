#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assert, parseArguments, readPackages, root } from "./package-catalog.mjs";

const requiredPackageFiles = new Set([
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.yml",
  "package.json",
]);

function command(commandName, arguments_, options = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${commandName} ${arguments_.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${output}`);
  }
}

function assertDryRunContents(package_, result) {
  const files = new Set(result.files.map((file) => file.path));
  for (const required of requiredPackageFiles) {
    assert(files.has(required), `${package_.manifest.name}: npm pack omits ${required}`);
  }

  const exportedFiles = [];
  const collectExportedFiles = (target) => {
    if (typeof target === "string") exportedFiles.push(target);
    else if (target && typeof target === "object") {
      for (const value of Object.values(target)) collectExportedFiles(value);
    }
  };
  collectExportedFiles(package_.manifest.exports);
  for (const file of exportedFiles) {
    assert(file.startsWith("./"), `${package_.manifest.name}: invalid export target ${file}`);
    assert(files.has(file.slice(2)), `${package_.manifest.name}: npm pack omits exported ${file}`);
  }
}

async function integrity(path) {
  const contents = await readFile(path);
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

function releaseManifest(package_, version) {
  const manifest = structuredClone(package_.manifest);
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const dependencies = manifest[section];
    if (!dependencies) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
      assert(
        name.startsWith("@davidilie/telemetry-"),
        `${package_.manifest.name}: cannot publish non-internal workspace dependency ${name}`,
      );
      dependencies[name] = version;
    }
    // Dependency key order is semantically irrelevant but byte-significant in
    // the tarball. Canonicalize it instead of relying on pnpm's asynchronous
    // workspace rewrite, which can produce a different order between runs.
    manifest[section] = Object.fromEntries(
      Object.entries(dependencies).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }
  return manifest;
}

async function stagePackage(package_, dryRun, stagingRoot, version) {
  const source = resolve(fileURLToPath(package_.path));
  const staging = resolve(stagingRoot, package_.directory);
  await mkdir(staging, { recursive: true });

  for (const file of dryRun.files) {
    const sourcePath = resolve(source, file.path);
    const destinationPath = resolve(staging, file.path);
    assert(
      sourcePath.startsWith(`${source}/`) &&
        destinationPath.startsWith(`${staging}/`),
      `${package_.manifest.name}: unsafe npm pack path ${file.path}`,
    );
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { recursive: true });
  }

  await writeFile(
    resolve(staging, "package.json"),
    `${JSON.stringify(releaseManifest(package_, version), null, 2)}\n`,
    "utf8",
  );
  return staging;
}

export async function packPackages({ output } = {}) {
  const destination = output
    ? resolve(output)
    : await mkdtemp(resolve(tmpdir(), "davidapps-telemetry-pack-"));
  await mkdir(destination, { recursive: true });

  const packages = await readPackages();
  const versions = new Set(packages.map((package_) => package_.manifest.version));
  assert(versions.size === 1, "all public packages must have the same release version");
  const version = [...versions][0];
  const stagingRoot = await mkdtemp(
    resolve(tmpdir(), "davidapps-telemetry-stage-"),
  );

  const packed = [];
  try {
    for (const package_ of packages) {
      // npm's dry run gives the exact publish file set. Copy only those files
      // into a temporary stage, then replace workspace ranges deterministically.
      const dryRun = parseJsonOutput(
        command("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
          cwd: fileURLToPath(package_.path),
        }),
        `${package_.manifest.name} npm pack --dry-run`,
      )[0];
      assertDryRunContents(package_, dryRun);
      const staging = await stagePackage(
        package_,
        dryRun,
        stagingRoot,
        version,
      );

      const packResult = parseJsonOutput(
        command(
          "npm",
          [
            "pack",
            staging,
            "--pack-destination",
            destination,
            "--json",
            "--ignore-scripts",
          ],
          { cwd: fileURLToPath(root) },
        ),
        `${package_.manifest.name} npm pack`,
      );
      const filename = packResult.filename ?? packResult[0]?.filename;
      assert(filename, `${package_.manifest.name}: npm pack did not report a filename`);
      const tarball = resolve(destination, filename);
      const packedManifest = parseJsonOutput(
        command("tar", ["-xOf", tarball, "package/package.json"]),
        `${package_.manifest.name} packed manifest`,
      );
      assert(
        packedManifest.name === package_.manifest.name,
        `${tarball}: package name changed while packing`,
      );
      assert(
        packedManifest.version === package_.manifest.version,
        `${package_.manifest.name}: package version changed while packing`,
      );

      for (const [name, dependencyVersion] of Object.entries(
        packedManifest.dependencies ?? {},
      )) {
        assert(
          !dependencyVersion.startsWith("workspace:"),
          `${package_.manifest.name}: ${name} still uses ${dependencyVersion}`,
        );
        if (name.startsWith("@davidilie/telemetry-")) {
          assert(
            dependencyVersion === package_.manifest.version,
            `${package_.manifest.name}: internal ${name} must be exactly ${package_.manifest.version}`,
          );
        }
      }

      packed.push({
        directory: package_.directory,
        name: packedManifest.name,
        version: packedManifest.version,
        filename: basename(filename),
        integrity: await integrity(tarball),
      });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const manifest = {
    schemaVersion: 1,
    version,
    packages: packed,
  };
  const manifestPath = resolve(destination, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Packed ${packed.length} packages at ${destination}`);
  console.log(manifestPath);
  return { destination, manifestPath, manifest };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await packPackages({ output: args.output });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`package packing failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
