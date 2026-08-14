import { readFile } from "node:fs/promises";

export const root = new URL("../", import.meta.url);
// This is both the public package catalog and publish order. Dependencies must
// precede adapters so a fresh scope can be bootstrapped in one release run.
export const packageDirectories = ["core", "web", "node", "next", "react-native"];

export async function readPackages() {
  return Promise.all(
    packageDirectories.map(async (directory) => ({
      directory,
      path: new URL(`packages/${directory}/`, root),
      manifest: JSON.parse(
        await readFile(new URL(`packages/${directory}/package.json`, root), "utf8"),
      ),
    })),
  );
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseArguments(argv) {
  const argumentsByName = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value !== undefined, `invalid argument near ${key ?? "<end>"}`);
    argumentsByName[key.slice(2)] = value;
  }
  return argumentsByName;
}
