import { readFile, readdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const license = await readFile(new URL("LICENSE", root), "utf8");
const packageDirectories = await readdir(new URL("packages/", root), {
  withFileTypes: true,
});

await Promise.all(
  packageDirectories
    .filter((directory) => directory.isDirectory())
    .map((directory) =>
      writeFile(
        new URL(`packages/${directory.name}/LICENSE`, root),
        license,
        "utf8",
      ),
    ),
);

console.log(`Synchronized ${packageDirectories.length} package license files.`);
