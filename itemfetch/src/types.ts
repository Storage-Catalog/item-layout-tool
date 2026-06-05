export type VersionManifestList = {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: VersionListEntry[];
};

export type VersionListEntry = {
  id: string;
  url: string;
  releaseTime: string;
  type: string;
  sha1: string;
};

export type DownloadEntry = {
  url: string;
  sha1?: string;
};

export type VersionManifest = {
  id?: string;
  downloads?: Record<string, DownloadEntry>;
};

export type BlockLootBehavior = {
  behavior: "default" | "no_loot_table" | "override_loot_table";
  noLootTable: boolean;
  overrideLootTable: string | null;
  overrideLootSourceBlock: string | null;
  propertiesExpression: string | null;
  helperMethod: string | null;
  copyFrom: string | null;
};

export type ParsedBlock = {
  fieldName: string;
  id: string;
  loot: BlockLootBehavior;
};

export type ParsedItem = {
  fieldName: string;
  id: string;
  registration: "block" | "item" | "spawn_egg" | "other";
  blockField: string | null;
  itemFactory: string | null;
  propertiesExpression: string | null;
  maxStackSize: number;
  maxDamage: number | null;
  rarity: string | null;
  fireResistant: boolean;
  foodReference: string | null;
  propertyCalls: Array<{ name: string; args: string[] }>;
  blockLoot: BlockLootBehavior | null;
};

export type ParsedFood = {
  fieldName: string;
  id: string;
  reference: string;
  initializer: string;
  nutrition: number | null;
  saturationModifier: number | null;
  alwaysEdible: boolean;
  usingConvertsTo: string | null;
  effects: Array<{
    effect: string;
    probability: number | null;
  }>;
  propertyCalls: Array<{ name: string; args: string[] }>;
};

export type ParsedCreativeTab = {
  fieldName: string;
  id: string;
  itemFields: string[];
};

export type VanillaBlockLootEntry = {
  blockField: string;
  lootMethod:
    | "drop_self"
    | "drop_other"
    | "drop_when_silk_touch"
    | "other_when_silk_touch"
    | "no_drop"
    | "custom";
  lootDropField: string | null;
};

export type LoadedJavaSources = {
  itemsJavaSource: string;
  blocksJavaSource: string;
  foodsJavaSource: string | null;
  creativeModeTabsJavaSource: string | null;
  vanillaBlockLootJavaSource: string | null;
  jarPath: string | null;
  cacheVersionRoot: string | null;
  minecraftVersion: string | null;
  sourceInfo: Record<string, unknown>;
};
