import { readFile, readdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const copies = await Promise.all(
  ["LICENSE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.yml"].map(async (name) => ({
    name,
    contents: await readFile(new URL(name, root), "utf8"),
  })),
);
const packageDirectories = await readdir(new URL("packages/", root), {
  withFileTypes: true,
});

await Promise.all(
  packageDirectories
    .filter((directory) => directory.isDirectory())
    .flatMap((directory) =>
      copies.map(({ name, contents }) =>
        writeFile(new URL(`packages/${directory.name}/${name}`, root), contents, "utf8"),
      ),
    ),
);

console.log(
  `Synchronized ${copies.length} provenance files across ${packageDirectories.length} packages.`,
);
