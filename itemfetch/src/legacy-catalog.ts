import { fetchJson } from "./utils";

// Versions older than 1.21.4 have no assets/minecraft/items definitions, and their code can't
// always be decompiled to readable names (Mojang mappings start at 1.14.4), so their item lists
// come from PrismarineJS minecraft-data (MIT) instead of the decompiled Items class.
export const MINECRAFT_DATA_URL =
  process.env.ITEMFETCH_MINECRAFT_DATA_URL ??
  "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data";

// The oldest version with assets/minecraft/items definitions; older ones are built from this module.
export const OLDEST_ITEM_DEFINITIONS_VERSION = "1.21.4";

// The last release of each major version, plus releases many servers stay on.
export const LEGACY_VERSIONS = [
  "1.21.3",
  "1.21.1",
  "1.20.6",
  "1.20.4",
  "1.20.1",
  "1.19.4",
  "1.19.2",
  "1.18.2",
  "1.17.1",
  "1.16.5",
  "1.15.2",
  "1.14.4",
  "1.13.2",
  "1.12.2",
];

// 1.12 predates the flattening: its items are listed under their 1.13 names (via minecraft-data's
// legacy table) and drawn from the 1.13.2 assets, which still have the same art.
const TEXTURE_VERSION_OVERRIDES: Record<string, string> = { "1.12.2": "1.13.2" };

// Item ids that were later renamed: old id -> current id. Used to find an item's creative tabs and
// item definition in the current catalogs; the catalog itself keeps the id of its own version.
const RENAMED_ITEM_IDS: Record<string, string> = {
  sign: "oak_sign",
  rose_red: "red_dye",
  dandelion_yellow: "yellow_dye",
  cactus_green: "green_dye",
  zombie_pigman_spawn_egg: "zombified_piglin_spawn_egg",
  grass_path: "dirt_path",
  grass: "short_grass",
  scute: "turtle_scute",
  chain: "iron_chain",
};

export type LegacyItem = { id: string; maxStackSize: number };

type MinecraftDataItem = { id: number; name: string; stackSize: number };
type DataPaths = { pc: Record<string, { items?: string }> };
type LegacyTable = { items: Record<string, string> };

export function textureVersionFor(gameVersion: string): string {
  return TEXTURE_VERSION_OVERRIDES[gameVersion] ?? gameVersion;
}

export function currentItemId(legacyId: string): string {
  return RENAMED_ITEM_IDS[legacyId] ?? legacyId;
}

export async function loadLegacyItems(gameVersion: string): Promise<LegacyItem[]> {
  const dataPaths = await fetchJson<DataPaths>(`${MINECRAFT_DATA_URL}/dataPaths.json`);
  const itemsPath = dataPaths.pc[gameVersion]?.items;
  if (!itemsPath) {
    throw new Error(`minecraft-data has no item list for Minecraft ${gameVersion}`);
  }
  const items = await fetchJson<MinecraftDataItem[]>(`${MINECRAFT_DATA_URL}/${itemsPath}/items.json`);

  if (!gameVersion.startsWith("1.12")) {
    return items.map((item) => ({ id: item.name, maxStackSize: item.stackSize }));
  }

  const legacy = await fetchJson<LegacyTable>(`${MINECRAFT_DATA_URL}/pc/common/legacy.json`);
  const stackSizeByNumericId = new Map(items.map((item) => [item.id, item.stackSize]));
  const flattened = new Map<string, number>();
  for (const [numericKey, namespacedId] of Object.entries(legacy.items)) {
    const stackSize = stackSizeByNumericId.get(Number.parseInt(numericKey, 10));
    if (stackSize !== undefined) {
      flattened.set(namespacedId.replace(/^minecraft:/, ""), stackSize);
    }
  }
  return Array.from(flattened, ([id, maxStackSize]) => ({ id, maxStackSize }));
}
