import { spawnSync } from "node:child_process";
import { VERSION_MANIFEST_URL } from "./src/config";
import { compareGameVersions } from "./src/catalog-store";
import { LEGACY_VERSIONS, OLDEST_ITEM_DEFINITIONS_VERSION } from "./src/legacy-catalog";
import type { VersionManifestList } from "./src/types";
import { fetchJson } from "./src/utils";

async function main(): Promise<void> {
  const manifestList = await fetchJson<VersionManifestList>(VERSION_MANIFEST_URL);
  // Newest first: the latest release keeps the plain <id>.png texture names, and the older
  // versions (from minecraft-data) need the current catalogs to exist already.
  const versions = [
    ...manifestList.versions
      .filter((entry) => entry.type === "release")
      .map((entry) => entry.id)
      .filter((id) => compareGameVersions(id, OLDEST_ITEM_DEFINITIONS_VERSION) >= 0)
      .sort((a, b) => compareGameVersions(b, a)),
    ...LEGACY_VERSIONS,
  ];

  const failed: string[] = [];
  for (const version of versions) {
    console.log(`\n=== Minecraft ${version} ===`);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "itemfetch/fetch-items.ts", "--game-version", version],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      failed.push(version);
    }
  }

  console.log(`\nFetched ${versions.length - failed.length}/${versions.length} versions.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
