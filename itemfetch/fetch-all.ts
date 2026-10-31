import { spawnSync } from "node:child_process";
import { VERSION_MANIFEST_URL } from "./src/config";
import { compareGameVersions } from "./src/catalog-store";
import type { VersionManifestList } from "./src/types";
import { fetchJson } from "./src/utils";

// Older releases have no assets/minecraft/items definitions, which fetch-items.ts relies on.
const OLDEST_SUPPORTED_VERSION = process.env.ITEMFETCH_OLDEST_VERSION ?? "1.21.4";

async function main(): Promise<void> {
  const manifestList = await fetchJson<VersionManifestList>(VERSION_MANIFEST_URL);
  // Newest first, so the latest release keeps the plain <id>.png texture names.
  const versions = manifestList.versions
    .filter((entry) => entry.type === "release")
    .map((entry) => entry.id)
    .filter((id) => compareGameVersions(id, OLDEST_SUPPORTED_VERSION) >= 0)
    .sort((a, b) => compareGameVersions(b, a));

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
