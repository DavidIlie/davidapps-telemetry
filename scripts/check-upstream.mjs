import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("UPSTREAM.yml", root), "utf8");

function parseSources(yaml) {
  const entries = [];
  let current;

  for (const [index, line] of yaml.split(/\r?\n/).entries()) {
    const name = line.match(/^  - name:\s+(.+)$/);
    if (name) {
      current = { name: name[1].trim(), line: index + 1 };
      entries.push(current);
      continue;
    }

    const property = line.match(/^    ([a-z]+):\s+(.+)$/);
    if (property && current) current[property[1]] = property[2].trim();
  }

  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const entries = parseSources(source);
assert(entries.length > 0, "UPSTREAM.yml has no sources");

const names = new Set();
for (const entry of entries) {
  const label = `${entry.name ?? "<unnamed>"} (line ${entry.line})`;
  assert(entry.name && !names.has(entry.name), `${label}: source name is missing or duplicated`);
  names.add(entry.name);
  assert(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repository),
    `${label}: repository must be an exact GitHub repository URL`,
  );
  assert(entry.license, `${label}: license is missing`);
  assert(
    /^[0-9a-f]{40}$/.test(entry.commit),
    `${label}: commit must be a full lowercase 40-character Git SHA`,
  );
  assert(
    entry.use === "dependency" || entry.use === "api-reference" || entry.use === "adaptation",
    `${label}: use must be dependency, api-reference, or adaptation`,
  );
}

// These tag objects were resolved against the official OpenTelemetry JS repository.
// Keeping the release-to-commit mapping executable prevents a vague dependency-version
// placeholder from silently returning to the provenance registry.
const otelReleases = new Map([
  ["v2.10.0", "76fa6b509e2b48d9cbee31cb37a2efc61dc4d384"],
  ["experimental/v0.221.0", "76fa6b509e2b48d9cbee31cb37a2efc61dc4d384"],
  ["v1.9.0", "08f597f3a3d71a4852b0afbba120af15ca038121"],
  ["v1.9.1", "279458e7ddf16f7ddca5fe60c78672e05fafce66"],
]);

for (const [release, commit] of otelReleases) {
  const match = entries.find(
    (entry) =>
      entry.repository === "https://github.com/open-telemetry/opentelemetry-js" &&
      entry.release === release,
  );
  assert(match, `UPSTREAM.yml does not track OpenTelemetry JS ${release}`);
  assert(match.commit === commit, `OpenTelemetry JS ${release} must resolve to ${commit}`);
}

const packageDirectories = ["core", "web", "node", "next", "react-native", "stripe"];
const dependencyVersions = new Set();
const supportedOtelVersions = new Set(["2.10.0", "0.221.0", "1.9.0", "1.9.1"]);
for (const directory of packageDirectories) {
  const manifest = JSON.parse(
    await readFile(new URL(`packages/${directory}/package.json`, root), "utf8"),
  );
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      if (name.startsWith("@opentelemetry/")) {
        assert(
          supportedOtelVersions.has(version),
          `${manifest.name}: ${name}@${version} has no exact release commit in check-upstream.mjs`,
        );
        dependencyVersions.add(version);
      }
    }
  }
}

for (const version of supportedOtelVersions) {
  assert(dependencyVersions.has(version), `expected an OpenTelemetry dependency pinned to ${version}`);
}

console.log(
  `Verified ${entries.length} exact upstream commits, including ${otelReleases.size} OpenTelemetry releases.`,
);
