import path from "node:path";

export const VERSION_MANIFEST_URL =
  process.env.ITEMFETCH_VERSION_MANIFEST_URL ??
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
export const FABRIC_MANIFEST_BASE_URL =
  process.env.ITEMFETCH_FABRIC_MANIFEST_BASE_URL ??
  "https://maven.fabricmc.net/net/minecraft";

export const CFR_VERSION = process.env.ITEMFETCH_CFR_VERSION ?? "0.152";
export const CFR_JAR_URL =
  process.env.ITEMFETCH_CFR_JAR_URL ??
  `https://repo1.maven.org/maven2/org/benf/cfr/${CFR_VERSION}/cfr-${CFR_VERSION}.jar`;
export const CFR_JAR_PATH_OVERRIDE = process.env.ITEMFETCH_CFR_JAR_PATH
  ? path.resolve(process.cwd(), process.env.ITEMFETCH_CFR_JAR_PATH)
  : null;

export const CACHE_ROOT = path.resolve(process.cwd(), "itemfetch/.cache/item-code");
export const TOOL_CACHE_ROOT = path.join(CACHE_ROOT, "tools");

export const OUTPUT_PATH = path.resolve(
  process.cwd(),
  process.env.ITEMFETCH_CODE_OUTPUT_PATH ?? "public/items/item-code.json",
);

export const LOCAL_ITEMS_JAVA_PATH = process.env.ITEMFETCH_ITEMS_JAVA_PATH
  ? path.resolve(process.cwd(), process.env.ITEMFETCH_ITEMS_JAVA_PATH)
  : null;
export const LOCAL_BLOCKS_JAVA_PATH = process.env.ITEMFETCH_BLOCKS_JAVA_PATH
  ? path.resolve(process.cwd(), process.env.ITEMFETCH_BLOCKS_JAVA_PATH)
  : null;
export const LOCAL_FOODS_JAVA_PATH = process.env.ITEMFETCH_FOODS_JAVA_PATH
  ? path.resolve(process.cwd(), process.env.ITEMFETCH_FOODS_JAVA_PATH)
  : null;
export const LOCAL_CREATIVE_MODE_TABS_JAVA_PATH =
  process.env.ITEMFETCH_CREATIVE_MODE_TABS_JAVA_PATH
    ? path.resolve(process.cwd(), process.env.ITEMFETCH_CREATIVE_MODE_TABS_JAVA_PATH)
    : null;
export const LOCAL_VANILLA_BLOCK_LOOT_JAVA_PATH =
  process.env.ITEMFETCH_VANILLA_BLOCK_LOOT_JAVA_PATH
    ? path.resolve(process.cwd(), process.env.ITEMFETCH_VANILLA_BLOCK_LOOT_JAVA_PATH)
    : null;

export const ITEM_CLASS_CANDIDATES = [
  "net/minecraft/world/item/Items.class",
  "net/minecraft/references/Items.class",
];
export const BLOCKS_CLASS_CANDIDATES = ["net/minecraft/world/level/block/Blocks.class"];
export const FOODS_CLASS_CANDIDATES = ["net/minecraft/world/food/Foods.class"];
export const CREATIVE_MODE_TABS_CLASS_CANDIDATES = [
  "net/minecraft/world/item/CreativeModeTabs.class",
];
export const VANILLA_BLOCK_LOOT_CLASS_CANDIDATES = [
  "net/minecraft/data/loot/packs/VanillaBlockLoot.class",
];

export function toFabricManifestUrl(versionId: string): string {
  const normalized = versionId.replace(/\./g, "_");
  return `${FABRIC_MANIFEST_BASE_URL}/${normalized}.json`;
}

export function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
