#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, parseArguments, readPackages, root } from "./package-catalog.mjs";

function git(...arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
  assert(result.status === 0, `git ${arguments_.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function verifyRelease({ tag, sha, allowDirty = false }) {
  assert(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag), `invalid release tag: ${tag}`);
  const version = tag.slice(1);
  const packages = await readPackages();

  for (const package_ of packages) {
    assert(
      package_.manifest.version === version,
      `${package_.manifest.name}@${package_.manifest.version} does not match ${tag}`,
    );
    assert(package_.manifest.private !== true, `${package_.manifest.name} is unexpectedly private`);
  }

  const head = git("rev-parse", "HEAD");
  assert(/^[0-9a-f]{40}$/.test(sha), `release SHA must be a full Git SHA: ${sha}`);
  assert(head === sha, `checked-out HEAD ${head} does not match release SHA ${sha}`);
  const tagCommit = git("rev-list", "-n", "1", tag);
  assert(tagCommit === sha, `${tag} points to ${tagCommit}, not ${sha}`);
  assert(git("describe", "--tags", "--exact-match", "HEAD") === tag, `HEAD is not exactly ${tag}`);
  if (!allowDirty) assert(git("status", "--porcelain") === "", "release worktree is dirty");

  console.log(`Verified ${tag} at ${sha} across ${packages.length} public packages.`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const tag = args.tag ?? process.env.RELEASE_TAG ?? git("describe", "--tags", "--exact-match", "HEAD");
  const sha = args.sha ?? process.env.RELEASE_SHA ?? git("rev-parse", "HEAD");
  await verifyRelease({ tag, sha, allowDirty: args["allow-dirty"] === "true" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release preflight failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
