import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./utils";

// Layout of public/items:
//   versions.json            { "versions": ["26.3", "26.2", ...] } newest first; the first is the default
//   <gameVersion>/items.json one catalog per game version
//   textures/                shared by all catalogs; an item keeps <id>.png while its texture is unchanged,
//                            a version whose texture differs gets <id>-<sha1 prefix>.png
export const CATALOG_ROOT = path.resolve(process.cwd(), "public/items");
export const TEXTURE_ROOT = path.join(CATALOG_ROOT, "textures");
const VERSIONS_INDEX_PATH = path.join(CATALOG_ROOT, "versions.json");

type VersionsIndex = { versions: string[] };

export function compareGameVersions(a: string, b: string): number {
  const aParts = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function catalogPathForVersion(gameVersion: string): string {
  return path.join(CATALOG_ROOT, gameVersion, "items.json");
}

async function readVersionsIndex(): Promise<VersionsIndex> {
  if (!(await pathExists(VERSIONS_INDEX_PATH))) {
    return { versions: [] };
  }
  const parsed = JSON.parse(await readFile(VERSIONS_INDEX_PATH, "utf8")) as Partial<VersionsIndex>;
  return { versions: Array.isArray(parsed.versions) ? parsed.versions : [] };
}

// Returns the public texture path. Concurrent calls must use distinct item ids.
export async function storeTexture(itemId: string, bytes: Buffer): Promise<string> {
  let filename = `${itemId}.png`;
  const plainPath = path.join(TEXTURE_ROOT, filename);
  if ((await pathExists(plainPath)) && !(await readFile(plainPath)).equals(bytes)) {
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
    filename = `${itemId}-${hash}.png`;
  }
  await writeFile(path.join(TEXTURE_ROOT, filename), bytes);
  return `/items/textures/${filename}`;
}

export async function registerCatalogVersion(gameVersion: string): Promise<void> {
  const index = await readVersionsIndex();
  const versions = Array.from(new Set([...index.versions, gameVersion])).sort(
    (a, b) => compareGameVersions(b, a),
  );
  await writeFile(VERSIONS_INDEX_PATH, `${JSON.stringify({ versions }, null, 2)}\n`, "utf8");
}

// Deletes textures that no registered catalog references any more.
export async function pruneUnusedTextures(): Promise<number> {
  const { versions } = await readVersionsIndex();
  const referenced = new Set<string>();
  for (const version of versions) {
    const catalog = JSON.parse(await readFile(catalogPathForVersion(version), "utf8")) as {
      items?: Array<{ texturePath?: string }>;
    };
    for (const item of catalog.items ?? []) {
      if (item.texturePath) {
        referenced.add(path.basename(item.texturePath));
      }
    }
  }

  await mkdir(TEXTURE_ROOT, { recursive: true });
  let removed = 0;
  for (const filename of await readdir(TEXTURE_ROOT)) {
    if (!referenced.has(filename)) {
      await rm(path.join(TEXTURE_ROOT, filename));
      removed += 1;
    }
  }
  return removed;
}
