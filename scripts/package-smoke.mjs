#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPackages } from "./pack-packages.mjs";
import { assert, root } from "./package-catalog.mjs";

function run(command, arguments_, cwd) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_config_")),
  );
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...environment,
      npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

const runtimeSpecifiers = [
  "@davidilie/telemetry-core",
  "@davidilie/telemetry-web",
  "@davidilie/telemetry-web/react",
  "@davidilie/telemetry-node",
  "@davidilie/telemetry-node/register",
  "@davidilie/telemetry-next",
  "@davidilie/telemetry-next/node",
  "@davidilie/telemetry-react-native",
  "@davidilie/telemetry-react-native/expo",
  "@davidilie/telemetry-stripe",
];

async function createExpoConstantsStub(consumer) {
  // The Expo helper only reads expo-constants. A tiny conditional-export stub lets
  // Node exercise both packed module formats without pretending Node is an Expo host.
  const directory = join(consumer, "node_modules", "expo-constants");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "expo-constants",
        version: "57.0.0-smoke",
        type: "module",
        exports: { import: "./index.mjs", require: "./index.cjs" },
      },
      null,
      2,
    )}\n`,
  );
  const constants = {
    expoConfig: { name: "Smoke App", slug: "smoke-app", version: "1.0.0" },
    executionEnvironment: "storeClient",
  };
  await writeFile(join(directory, "index.mjs"), `export default ${JSON.stringify(constants)};\n`);
  await writeFile(join(directory, "index.cjs"), `module.exports = ${JSON.stringify(constants)};\n`);
}

export async function smokePackages() {
  const packed = await packPackages();
  const repeatedPack = await packPackages();
  const firstIntegrities = packed.manifest.packages.map(({ name, integrity }) => ({
    name,
    integrity,
  }));
  const repeatedIntegrities = repeatedPack.manifest.packages.map(({ name, integrity }) => ({
    name,
    integrity,
  }));
  assert(
    JSON.stringify(firstIntegrities) === JSON.stringify(repeatedIntegrities),
    "two clean package runs produced different tarball integrity values",
  );
  await rm(repeatedPack.destination, { recursive: true, force: true });
  const consumer = join(packed.destination, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "telemetry-tarball-smoke", private: true, type: "module" }, null, 2)}\n`,
  );

  const tarballs = packed.manifest.packages.map((package_) =>
    join(packed.destination, package_.filename),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      ...tarballs,
      "react@19.2.3",
      "@types/react@19.2.18",
    ],
    consumer,
  );
  await createExpoConstantsStub(consumer);

  await writeFile(
    join(consumer, "esm-smoke.mjs"),
    `const specifiers = ${JSON.stringify(runtimeSpecifiers)};
for (const specifier of specifiers) {
  const module = await import(specifier);
  if (Object.keys(module).length === 0) throw new Error(\`\${specifier} has no ESM exports\`);
}
`,
  );
  await writeFile(
    join(consumer, "cjs-smoke.cjs"),
    `const specifiers = ${JSON.stringify(runtimeSpecifiers)};
for (const specifier of specifiers) {
  const module = require(specifier);
  if (Object.keys(module).length === 0) throw new Error(\`\${specifier} has no CJS exports\`);
}
`,
  );
  await writeFile(
    join(consumer, "types-smoke.mts"),
    `${runtimeSpecifiers.map((specifier) => `import * as m${runtimeSpecifiers.indexOf(specifier)} from ${JSON.stringify(specifier)};`).join("\n")}
export const modules = [${runtimeSpecifiers.map((_, index) => `m${index}`).join(", ")}];
`,
  );

  run("node", ["esm-smoke.mjs"], consumer);
  run("node", ["cjs-smoke.cjs"], consumer);
  run(
    "pnpm",
    [
      "exec",
      "tsc",
      "--noEmit",
      "--skipLibCheck",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      resolve(consumer, "types-smoke.mts"),
    ],
    fileURLToPath(root),
  );

  console.log(
    `Smoke-tested ${packed.manifest.packages.length} tarballs across ESM, CJS, types, and ${runtimeSpecifiers.length} export paths.`,
  );
  await rm(packed.destination, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokePackages().catch((error) => {
    console.error(`package smoke test failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
