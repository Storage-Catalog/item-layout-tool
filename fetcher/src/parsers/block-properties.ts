import type { ParserDiagnostic } from "../java/parser-utils";
import type { BlockBehaviorsParseResult, ResolvedBlockBehavior } from "./block-behaviors";
import type { BlockEntitiesParseResult } from "./block-entities";
import type { BlockTagsParseResult } from "./block-tags";
import type { BlocksParseResult, BlockDefinition } from "./blocks";
import type { ResolvedBlockShapeMethod } from "./block-shapes";
import type { FlammabilityParseResult } from "./flammability";
import type { ItemsParseResult } from "./items";
import type { LootTablesParseResult, ParsedLootTable } from "./loot-tables";
import type { RecipesParseResult } from "./recipes";
import type { WorldgenStructuresParseResult } from "./worldgen-structures";

export type LegacyPropertyCoverageStatus = "direct" | "derived" | "partial" | "missing" | "legacy" | "external";

export type LegacyPropertyCoverage = {
  id: string;
  status: LegacyPropertyCoverageStatus;
  source: string[];
  note: string;
};

export type BlockPropertySummary = {
  id: string;
  fieldName: string;
  blockClass: string | null;
  states: {
    propertyNames: string[];
    propertyValues: Record<string, string[]>;
    variantCount: number;
    multipartCount: number;
  };
  tags: string[];
  tagPaths: string[];
  familyTags: {
    mineable: string[];
    needsTool: string[];
    incorrectForTool: string[];
  };
  item: {
    exists: boolean;
    itemId: string | null;
    maxStackSize: number | null;
    itemClass: string | null;
  };
  registrationProperties: {
    mapColor: string | null;
    instrument: string | null;
    soundType: string | null;
    pushReaction: string | null;
    hardness: number | null;
    blastResistance: number | null;
    luminanceExpression: string | null;
    requiresCorrectToolForDrops: boolean;
    noLootTable: boolean;
    overrideLootTable: string | null;
    noCollision: boolean;
    noOcclusion: boolean;
    replaceable: boolean;
    air: boolean;
    liquid: boolean;
    randomTicks: boolean;
    ignitedByLava: boolean;
    dynamicShape: boolean;
    forceSolidOn: boolean;
    forceSolidOff: boolean;
    offsetType: string | null;
  };
  shape: {
    hasCollision: boolean | null;
    collisionSource: string | null;
    occlusionSource: string | null;
    shapeFieldNames: string[];
    methodNames: string[];
    returnsEmptyShape: boolean;
    returnsFullBlockShape: boolean;
    usesState: boolean;
    usesLevel: boolean;
    usesPosition: boolean;
    usesCollisionContext: boolean;
    notes: string[];
  };
  loot: {
    lootTableId: string | null;
    hasLootTable: boolean;
    droppedItemIds: string[];
    conditionTypes: string[];
    functionTypes: string[];
    requiresSilkTouchToDropSelf: boolean | null;
    hasSilkTouchPath: boolean;
    hasShearsPath: boolean;
    hasExplosionCondition: boolean;
    datagenRuleNames: string[];
    datagenHelperNames: string[];
    customGenerators: string[];
  };
  crafting: {
    recipeIdsForItem: string[];
    recipeTypesForItem: string[];
  };
  flammability: {
    flammable: boolean;
    igniteOdds: number | null;
    burnOdds: number | null;
  };
  blockEntity: {
    hasBlockEntity: boolean;
    typeIds: string[];
    typeFieldNames: string[];
  };
  worldgen: {
    generatesInStructures: boolean;
    structureSourceIds: string[];
    structureSourceTypes: string[];
  };
  behavior: {
    classChain: string[];
    methodNames: string[];
    signalSource: boolean;
    analogOutput: boolean;
    placementConditionSources: string[];
    pathfindableSources: string[];
    updateShape: boolean;
    neighborChanged: boolean;
    entityInside: boolean;
    stepOn: boolean;
    fallOn: boolean;
    referencedBlockTags: string[];
    referencedBlocks: string[];
  };
  availability: {
    survivalAvailable: "creatable" | "obtainable" | "unobtainable" | "unknown";
    reasons: string[];
  };
  derivedLegacyProperties: Record<string, string | number | boolean | null | string[]>;
  missingLegacyProperties: string[];
  diagnostics: ParserDiagnostic[];
};

export type BlockPropertiesParseResult = {
  blocks: BlockPropertySummary[];
  blockById: Record<string, BlockPropertySummary>;
  legacyPropertyCoverage: LegacyPropertyCoverage[];
  missingLegacyProperties: string[];
  partialLegacyProperties: string[];
  diagnostics: ParserDiagnostic[];
};

const LEGACY_PROPERTY_COVERAGE: LegacyPropertyCoverage[] = [
  ...[
    "variants",
    "hardness",
    "blast_resistance",
    "instrument",
    "map_color",
    "luminance",
    "ignited_by_lava",
    "replaceable",
    "liquid",
    "gets_random_ticked",
    "has_collision",
    "exists_as_item",
    "requires_silk_touch",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "direct",
    source: ["blocks", "items", "block-states", "loot-tables"],
    note: "Collected directly or normalized from existing parser output.",
  })),
  ...[
    "block_entity",
    "flammable",
    "ignite_odds",
    "burn_odds",
    "falling_block",
    "intended_tool",
    "survival_available",
    "waterloggable",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "derived",
    source: ["block-entities", "flammability", "block-tags", "block-states", "recipes", "loot-tables"],
    note: "Derived from current code/data sources in block-properties.json.",
  })),
  ...[
    "block_render_type",
    "fluid_render_type",
    "full_cube",
    "height_all",
    "height_external",
    "width_all",
    "width_external",
    "collision_bottom_all",
    "collision_bottom_external",
    "top_face_has_collision",
    "bottom_face_has_collision",
    "side_face_has_collision",
    "top_face_has_full_square",
    "bottom_face_has_full_square",
    "side_face_has_full_square",
    "top_face_has_small_square",
    "bottom_face_has_small_square",
    "top_face_has_rim",
    "is_opaque_full_cube",
    "opaque",
    "opacity",
    "blocks_skylight",
    "blocks_beacon_beam",
    "movable",
    "sticky",
    "xp_dropped_when_mined",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "partial",
    source: ["blocks", "block-shapes", "block-states", "block-tags", "loot-tables"],
    note: "Some source facts are present, but exact old table values require shape/light/behavior evaluation.",
  })),
  ...[
    "conductive",
    "redirects_redstone",
    "emits_power",
    "comparator_output",
    "sends_comparator_updates",
    "shape_update_when_powered",
    "shape_update_on_interaction",
    "shape_update_from_environment",
    "obstructs_cactus",
    "obstructs_tree_growth",
    "connects_to_panes",
    "connects_to_walls",
    "kills_grass",
    "affects_movement_speed",
    "inflicts_damage",
    "dragon_immune",
    "wither_block_break_immune",
    "wither_skull_immune",
    "suffocates_mobs",
    "spawnable",
    "raid_spawnable",
    "iron_golem_spawnable_on",
    "gets_destroyed_by_lava",
    "gets_flushed",
    "instant_mineable",
    "supports_redstone_dust",
    "placement_condition",
    "water_forms_source_above",
    "pathfindable_through",
    "pathfinding_penalty",
    "block_entity_data",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "derived",
    source: ["block-behaviors", "block-tags", "block-shapes", "block-entities"],
    note: "Extracted or approximated from current block methods, tags, properties, and shape behavior.",
  })),
  ...[
    "instant_shape_updater",
    "instant_block_updater",
    "instant_updater",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "derived",
    source: ["block-behaviors"],
    note: "Old table marked this as not updated; current output derives update behavior from method overrides.",
  })),
  ...[
    "material",
    "material_is_liquid",
    "material_is_solid",
    "material_blocks_movement",
    "material_is_burnable",
    "material_is_replaceable",
    "material_blocks_light",
    "blocks_motion",
    "solid",
  ].map((id): LegacyPropertyCoverage => ({
    id,
    status: "legacy",
    source: [],
    note: "Legacy pre-1.20 material concepts; not present as first-class current game data.",
  })),
  ...["generates_in_structures", "numerical_id", "wiki_page"].map((id): LegacyPropertyCoverage => ({
    id,
    status: "external",
    source: ["worldgen/structure assets", "external docs"],
    note: "Requires structure/worldgen scanning or external/manual sources.",
  })),
];

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function stripMinecraftNamespace(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

function tagPath(tagId: string): string {
  return stripMinecraftNamespace(tagId);
}

function hasTag(tagPaths: Set<string>, path: string): boolean {
  return tagPaths.has(path);
}

function hasFluidRef(block: BlockDefinition, fluidId: string): boolean {
  return block.fluidRefs.includes(normalizeIdentifier(fluidId));
}

function tagsMatching(tagPaths: Set<string>, prefixOrValues: string[] | string): string[] {
  const values = Array.isArray(prefixOrValues) ? prefixOrValues : [prefixOrValues];
  return Array.from(tagPaths).filter((pathValue) =>
    values.some((value) => pathValue === value || pathValue.startsWith(`${value}/`)),
  ).sort();
}

function blockLootTableId(blockId: string): string {
  return `minecraft:blocks/${stripMinecraftNamespace(blockId)}`;
}

function lootRequiresSilkTouchToDropSelf(block: BlockDefinition, lootTable: ParsedLootTable | null): boolean | null {
  if (block.noLootTable || !lootTable) {
    return null;
  }
  const blockId = block.id ?? "";
  const rawLoot = JSON.stringify(lootTable.raw);
  if (lootTable.datagenSemantics.hasDropWhenSilkTouch || lootTable.datagenSemantics.hasOtherWhenSilkTouch) {
    return true;
  }
  if (
    blockId &&
    lootTable.itemIds.includes(blockId) &&
    rawLoot.includes("minecraft:silk_touch") &&
    !rawLoot.includes("minecraft:shears")
  ) {
    return true;
  }
  if (lootTable.datagenSemantics.hasSilkTouch && lootTable.itemIds.includes(blockId)) {
    return false;
  }
  return false;
}

function recipeIdsForItem(recipes: RecipesParseResult | null, itemId: string | null): string[] {
  if (!recipes || !itemId) {
    return [];
  }
  return recipes.recipes
    .filter((recipe) => recipe.result?.id === itemId)
    .map((recipe) => recipe.id)
    .sort();
}

function recipeTypesForItem(recipes: RecipesParseResult | null, itemId: string | null): string[] {
  if (!recipes || !itemId) {
    return [];
  }
  return Array.from(
    new Set(
      recipes.recipes
        .filter((recipe) => recipe.result?.id === itemId)
        .map((recipe) => recipe.type),
    ),
  ).sort();
}

function itemForBlock(items: ItemsParseResult | null, blockId: string): { id: string; itemClass: string | null; maxStackSize: number | null } | null {
  if (!items) {
    return null;
  }
  const item = items.items.find((entry) => entry.blockId === blockId && entry.id);
  return item?.id ? { id: item.id, itemClass: item.itemClass, maxStackSize: item.maxStackSize } : null;
}

function shapeSummary(block: BlockDefinition): BlockPropertySummary["shape"] {
  const behavior = block.shapeBehavior;
  const methods = behavior ? Object.values(behavior.methods).filter(Boolean) : [];
  const resolvedMethods = methods.map((entry) => entry.method);
  return {
    hasCollision: behavior?.hasCollision ?? !block.noCollision,
    collisionSource: behavior?.collisionSource ?? null,
    occlusionSource: behavior?.occlusionSource ?? null,
    shapeFieldNames: behavior?.shapeFieldNames ?? [],
    methodNames: methods.map((entry) => entry.methodName).sort(),
    returnsEmptyShape: resolvedMethods.some((method) => method.returnExpressions.some((expression) => expression.parsed.kind === "empty")),
    returnsFullBlockShape: resolvedMethods.some((method) => method.returnExpressions.some((expression) => expression.parsed.kind === "full_block")),
    usesState: resolvedMethods.some((method) => method.usesState),
    usesLevel: resolvedMethods.some((method) => method.usesLevel),
    usesPosition: resolvedMethods.some((method) => method.usesPosition),
    usesCollisionContext: resolvedMethods.some((method) => method.usesCollisionContext),
    notes: behavior?.notes ?? [],
  };
}

function behaviorForBlock(block: BlockDefinition, blockBehaviors: BlockBehaviorsParseResult | null): ResolvedBlockBehavior | null {
  return block.blockClass ? blockBehaviors?.resolvedByClassName[block.blockClass] ?? null : null;
}

function hasBehaviorMethod(behavior: ResolvedBlockBehavior | null, methodName: string): boolean {
  const method = behavior?.methods[methodName];
  return Boolean(method && method.sourceClassName !== "BlockBehaviour" && method.sourceClassName !== "Block");
}

type ResolvedBehaviorMethod = ResolvedBlockBehavior["methods"][string];

function behaviorMethod(behavior: ResolvedBlockBehavior | null, methodName: string): ResolvedBehaviorMethod | null {
  const method = behavior?.methods[methodName];
  if (!method || method.sourceClassName === "BlockBehaviour" || method.sourceClassName === "Block") {
    return null;
  }
  return method;
}

function behaviorMethodImplementations(behavior: ResolvedBlockBehavior | null, methodName: string): ResolvedBehaviorMethod[] {
  return (behavior?.methodImplementations[methodName] ?? []).filter(
    (method) => method.sourceClassName !== "BlockBehaviour" && method.sourceClassName !== "Block",
  );
}

function hasExternalDefaultBlockStateCall(source: string): boolean {
  const ownerRe = /((?:[A-Za-z_$][\w$]*|this)(?:(?:\.[A-Za-z_$][\w$]*)|\(\))*)\.defaultBlockState\s*\(/g;
  for (const match of source.matchAll(ownerRe)) {
    if (match[1] !== "this") {
      return true;
    }
  }
  return /\bBlocks\.[A-Z0-9_]+\b[^;]*\.defaultBlockState\s*\(/.test(source);
}

function methodReturnsReplacementOrRemoval(method: ResolvedBehaviorMethod | null): boolean {
  if (!method) {
    return false;
  }
  return method.returnExpressions.some((expression) => {
    const source = expression.replace(/\s+/g, " ");
    return (
      /\bBlocks\.AIR\.defaultBlockState\s*\(/.test(source) ||
      /\bBlock\.pushEntitiesUp\s*\(/.test(source) ||
      hasExternalDefaultBlockStateCall(source)
    );
  });
}

function methodSetsSelfToReplacement(method: ResolvedBehaviorMethod | null): boolean {
  if (!method) {
    return false;
  }
  const source = method.source.replace(/\s+/g, " ");
  const setSelfRe = /\b(?:level|serverLevel)\.setBlock(?:AndUpdate)?\s*\(\s*pos\s*,\s*([^;]+);/g;
  for (const match of source.matchAll(setSelfRe)) {
    if (/\bBlocks\.AIR\.defaultBlockState\s*\(/.test(match[1]) || hasExternalDefaultBlockStateCall(match[1])) {
      return true;
    }
  }
  return /\bturnToDirt\s*\(/.test(source);
}

function scheduledTickReplacesOrRemovesSelf(behavior: ResolvedBlockBehavior | null): boolean {
  const schedulesSelfTick = behaviorMethodImplementations(behavior, "updateShape").some((method) =>
    /\bticks\.scheduleTick\s*\(\s*pos\s*,\s*this\b/.test(method.source),
  );
  if (!schedulesSelfTick) {
    return false;
  }
  const tick = behaviorMethod(behavior, "tick");
  return Boolean(
    tick &&
      (/\bFallingBlockEntity\.fall\s*\(/.test(tick.source) ||
        /\bdestroyBlock\s*\(\s*pos\b/.test(tick.source) ||
        /\bremoveBlock\s*\(\s*pos\b/.test(tick.source) ||
        methodSetsSelfToReplacement(tick)),
  );
}

function randomTickReplacesSelf(behavior: ResolvedBlockBehavior | null): boolean {
  return behaviorMethodImplementations(behavior, "randomTick").some(methodSetsSelfToReplacement);
}

function methodReturnSources(behavior: ResolvedBlockBehavior | null, methodNames: string[]): string[] {
  return Array.from(
    new Set(
      methodNames.flatMap((methodName) => behavior?.methods[methodName]?.returnExpressions ?? []),
    ),
  ).sort();
}

function placementConditionSources(behavior: ResolvedBlockBehavior | null): string[] {
  const methodNames = ["canSurvive", "mayPlaceOn"];
  const sources = methodNames.flatMap((methodName) => {
    const method = behavior?.methods[methodName];
    if (!method || method.sourceClassName === "BlockBehaviour" || method.sourceClassName === "Block") {
      return [];
    }
    const nonConstantReturns = method.returnExpressions.filter((expression) => !/^(?:true|false)$/.test(expression));
    return [...method.conditionExpressions, ...nonConstantReturns];
  });
  return Array.from(new Set(sources)).sort();
}

function pathfindableValue(input: {
  block: BlockDefinition;
  behavior: ResolvedBlockBehavior | null;
  tagPaths: Set<string>;
}): string | string[] {
  if (input.block.air) {
    return "OPEN";
  }
  if (hasTag(input.tagPaths, "leaves")) {
    return "LEAVES";
  }
  if (input.block.liquid) {
    if (hasFluidRef(input.block, "water")) return "WATER";
    if (hasFluidRef(input.block, "lava")) return "LAVA";
    return "DAMAGE_FIRE";
  }
  if (hasTag(input.tagPaths, "rails")) {
    return "RAIL";
  }
  if (hasTag(input.tagPaths, "fences") || hasTag(input.tagPaths, "walls")) {
    return "FENCE";
  }
  if (hasTag(input.tagPaths, "doors")) {
    return "DOOR";
  }
  if (hasTag(input.tagPaths, "trapdoors") || /TrapdoorBlock/.test(input.block.blockClass ?? "")) {
    return "TRAPDOOR";
  }
  if (/Cactus|Berry|Campfire|Magma|FireBlock/.test(input.block.blockClass ?? "")) {
    return /Campfire|Magma|FireBlock/.test(input.block.blockClass ?? "") ? "DAMAGE_FIRE" : "DAMAGE_OTHER";
  }
  const pathfindableOverride = input.behavior?.methods.isPathfindable;
  if (
    pathfindableOverride &&
    pathfindableOverride.sourceClassName !== "BlockBehaviour" &&
    pathfindableOverride.sourceClassName !== "Block"
  ) {
    if (pathfindableOverride.returnExpressions.some((expression) => /\btrue\b/.test(expression))) {
      return "OPEN";
    }
    if (pathfindableOverride.returnExpressions.some((expression) => /\bfalse\b/.test(expression))) {
      return "BLOCKED";
    }
  }
  return input.block.noCollision || input.block.replaceable ? "OPEN" : "BLOCKED";
}

function pathfindingPenalty(pathfindable: string | string[]): number {
  const value = Array.isArray(pathfindable) ? pathfindable.join(" ") : pathfindable;
  if (value === "WATER") {
    return 8;
  }
  if (value === "DAMAGE_FIRE") {
    return 16;
  }
  if (value.startsWith("DAMAGE")) {
    return -1;
  }
  if (["OPEN", "RAIL", "TRAPDOOR"].includes(value)) {
    return 0;
  }
  return -1;
}

function behaviorReferencedTags(behavior: ResolvedBlockBehavior | null): string[] {
  return Array.from(
    new Set(Object.values(behavior?.methods ?? {}).flatMap((method) => method.referencedBlockTags)),
  ).sort();
}

function behaviorReferencedBlocks(behavior: ResolvedBlockBehavior | null): string[] {
  return Array.from(
    new Set(Object.values(behavior?.methods ?? {}).flatMap((method) => method.referencedBlocks)),
  ).sort();
}

function propertyReturnSources(block: BlockDefinition, propertyNames: string[]): string[] {
  return Array.from(
    new Set(
      block.propertyCalls
        .filter((call) => propertyNames.includes(call.name))
        .flatMap((call) => call.args.length > 0 ? [call.args.join(", ")] : [call.source]),
    ),
  ).sort();
}

function propertyPredicateValue(block: BlockDefinition, propertyNames: string[]): boolean | string[] | null {
  const sources = propertyReturnSources(block, propertyNames);
  if (sources.length === 0) {
    return null;
  }
  if (sources.some((source) => /\bfalse\b|Blocks::never|BlockBehaviour\.Properties::never/.test(source))) {
    return false;
  }
  if (sources.some((source) => /\btrue\b|Blocks::always|BlockBehaviour\.Properties::always/.test(source))) {
    return true;
  }
  return sources;
}

function shapeMethodIsFullBlock(method: ResolvedBlockShapeMethod | null | undefined): boolean | null {
  if (!method) {
    return null;
  }
  if (method.sourceClassName === "BlockBehaviour" && method.methodName === "getShape") {
    return true;
  }
  const returns = method.method.returnExpressions;
  if (returns.length === 0) {
    return null;
  }
  if (returns.every((entry) => entry.parsed.kind === "full_block")) {
    return true;
  }
  if (returns.every((entry) => entry.parsed.kind === "empty")) {
    return false;
  }
  return false;
}

function outlineShapeIsFullBlock(block: BlockDefinition): boolean {
  if (block.air) {
    return false;
  }
  const shapeMethod = block.shapeBehavior?.methods.getShape ?? null;
  const full = shapeMethodIsFullBlock(shapeMethod);
  if (full !== null) {
    return full;
  }
  return true;
}

function collisionShapeIsFullBlock(block: BlockDefinition): boolean {
  if (block.air || block.liquid || block.noCollision) {
    return false;
  }
  const behavior = block.shapeBehavior;
  const collisionMethod = behavior?.methods.getCollisionShape ?? behavior?.methods.getShape ?? null;
  if (collisionMethod?.sourceClassName === "BlockBehaviour" && collisionMethod.methodName === "getCollisionShape") {
    const shapeMethod = behavior?.methods.getShape ?? null;
    if (!shapeMethod || shapeMethod.sourceClassName === "BlockBehaviour") {
      return true;
    }
    return shapeMethodIsFullBlock(shapeMethod) ?? false;
  }
  if (collisionMethod?.sourceClassName === "BlockBehaviour" && collisionMethod.methodName === "getShape") {
    return true;
  }
  const full = shapeMethodIsFullBlock(collisionMethod);
  if (full !== null) {
    return full;
  }
  return true;
}

function legacyIntendedTool(
  block: BlockDefinition,
  familyTags: { mineable: string[] },
  lootTable: ParsedLootTable | null,
): string | string[] {
  if (block.air || block.strength === -1 || block.liquid) {
    return "Not Applicable";
  }
  const tools = familyTags.mineable.map((value) => value.replace(/^mineable\//, ""));
  if (tools.length === 0) {
    return "By Hand";
  }
  if (tools.includes("hoe") && lootTable?.datagenSemantics.hasShears) {
    return "Shears or Hoe";
  }
  if (tools.includes("sword") && lootTable?.datagenSemantics.hasShears) {
    return "Shears or Sword";
  }
  if (tools.includes("sword") && tools.includes("shears")) {
    return "Shears or Sword";
  }
  if (tools.includes("hoe") && tools.includes("shears")) {
    return "Shears or Hoe";
  }
  return tools;
}

function legacyWaterloggable(block: BlockDefinition, state: BlockDefinition["blockStateDefinition"], tagPaths: Set<string>): boolean | string {
  if (
    (block.liquid && hasFluidRef(block, "water")) ||
    hasTag(tagPaths, "seagrass") ||
    /(?:Kelp|Seagrass|BubbleColumn)Block/.test(block.blockClass ?? "")
  ) {
    return "Inherent";
  }
  if (state?.propertyNames.includes("waterlogged")) {
    return true;
  }
  if (hasTag(tagPaths, "leaves") || hasTag(tagPaths, "rails") || hasTag(tagPaths, "stairs")) {
    return true;
  }
  return /(?:Chest|Fence|FenceGate|Wall|Sign|HangingSign|Stair|Slab|Lantern|Chain|Candle|Campfire|Coral|Ladder|Scaffolding|MangroveRoots)Block/.test(
    block.blockClass ?? "",
  );
}

function legacyShapeUpdateFromEnvironment(behavior: ResolvedBlockBehavior | null): string | boolean {
  if (hasBehaviorMethod(behavior, "updateShape")) {
    if (
      behaviorMethodImplementations(behavior, "updateShape").some(methodReturnsReplacementOrRemoval) ||
      scheduledTickReplacesOrRemovesSelf(behavior) ||
      randomTickReplacesSelf(behavior)
    ) {
      return false;
    }
    return "On reaction";
  }
  if (hasBehaviorMethod(behavior, "onPlace") || hasBehaviorMethod(behavior, "neighborChanged")) {
    return "Other";
  }
  return false;
}

function legacyBlockEntityKind(blockEntityTypeIds: string[], behavior: ResolvedBlockBehavior | null): string | boolean {
  if (blockEntityTypeIds.length === 0) {
    return false;
  }
  return hasBehaviorMethod(behavior, "getTicker") ? "Ticking" : "Non-Ticking";
}

function legacyOpaque(block: BlockDefinition, tagPaths: Set<string>, collisionFullBlock: boolean): boolean {
  if (block.air || block.liquid || block.noCollision) {
    return false;
  }
  if (hasTag(tagPaths, "leaves") || hasTag(tagPaths, "impermeable")) {
    return false;
  }
  if (
    /(?:Sapling|Propagule|Bush|Grass|Flower|Mushroom|Fungus|Roots|Vine|Kelp|Seagrass|Fire|Portal|Bed|Rail|Button|PressurePlate|Carpet|Candle|Torch|Sign|Banner|Coral|Ladder|Lantern|Chain|Pane|Bars|TrapDoor|ShulkerBox|Hopper|Honey|Slime|Scaffolding|Cactus|Cake|Cauldron)Block/.test(
      block.blockClass ?? "",
    )
  ) {
    return false;
  }
  return collisionFullBlock || !block.noOcclusion;
}

function legacyOpacity(block: BlockDefinition, tagPaths: Set<string>, opaque: boolean): number {
  if (block.air) {
    return 0;
  }
  if (block.liquid || hasTag(tagPaths, "leaves")) {
    return 1;
  }
  return opaque ? 15 : 0;
}

function legacyShapeUpdateOnInteraction(behavior: ResolvedBlockBehavior | null): string | boolean {
  if (hasBehaviorMethod(behavior, "useWithoutItem") || hasBehaviorMethod(behavior, "attack")) {
    return "With hand";
  }
  if (hasBehaviorMethod(behavior, "useItemOn")) {
    return "With item";
  }
  if (
    hasBehaviorMethod(behavior, "entityInside") ||
    hasBehaviorMethod(behavior, "stepOn") ||
    hasBehaviorMethod(behavior, "fallOn")
  ) {
    return "Touching entity";
  }
  return false;
}

function behaviorBooleanOverride(behavior: ResolvedBlockBehavior | null, methodName: string): boolean | null {
  const method = behavior?.methods[methodName];
  if (!method || method.sourceClassName === "BlockBehaviour") {
    return null;
  }
  if (method.returnExpressions.some((expression) => /\bfalse\b/.test(expression))) {
    return false;
  }
  if (method.returnExpressions.some((expression) => /\btrue\b/.test(expression))) {
    return true;
  }
  return null;
}

function isMostlyNonSolid(block: BlockDefinition, shape: BlockPropertySummary["shape"], collisionFullBlock: boolean): boolean {
  const hasStatefulOrContextualShape =
    shape.usesState ||
    shape.usesLevel ||
    shape.usesPosition ||
    shape.usesCollisionContext ||
    shape.returnsEmptyShape;
  const hasCustomShapeFields = block.blockClass !== "Block" && shape.shapeFieldNames.length > 0;
  return (
    block.air ||
    block.liquid ||
    block.noCollision ||
    block.noOcclusion ||
    shape.hasCollision === false ||
    !collisionFullBlock ||
    (shape.methodNames.length > 0 && !shape.returnsFullBlockShape && hasStatefulOrContextualShape) ||
    (hasCustomShapeFields && !shape.returnsFullBlockShape)
  );
}

function legacyRenderType(block: BlockDefinition, shape: BlockPropertySummary["shape"]): string {
  if (block.air) {
    return "solid";
  }
  if (block.liquid) {
    return "translucent";
  }
  if (shape.returnsEmptyShape || block.noOcclusion) {
    return "cutout";
  }
  return "solid";
}

function legacyFluidRenderType(block: BlockDefinition, waterloggable: boolean): string {
  if (block.liquid || waterloggable) {
    return "translucent";
  }
  return "solid";
}

function isEntityInteractionBlock(block: BlockDefinition, behavior: ResolvedBlockBehavior | null, tagPaths: Set<string>): boolean | string[] {
  const reasons: string[] = [];
  if (hasBehaviorMethod(behavior, "entityInside")) reasons.push("entityInside");
  if (hasBehaviorMethod(behavior, "stepOn")) reasons.push("stepOn");
  if (hasBehaviorMethod(behavior, "fallOn")) reasons.push("fallOn");
  if (hasTag(tagPaths, "climbable")) reasons.push("climbable tag");
  return reasons.length > 0 ? reasons : false;
}

function instantMineable(block: BlockDefinition, intendedTool: string | string[]): string | boolean | null {
  if (block.air || block.liquid || intendedTool === "Not Applicable") {
    return null;
  }
  if (block.strength === null) {
    return intendedTool === "By Hand" ? "By Hand" : null;
  }
  if (block.strength < 0) {
    return "Unbreakable";
  }
  if (block.strength === 0) {
    return true;
  }
  if (intendedTool === "By Hand") {
    return block.strength <= 1 ? "By Hand" : false;
  }
  if (block.strength <= 35 / 30) {
    return "With eff. V Diamond";
  }
  if (block.strength <= 38 / 30) {
    return "With eff. V Gold";
  }
  if (block.strength <= 49 / 30) {
    return "With Haste II";
  }
  return false;
}

function pistonMovementValue(
  block: BlockDefinition,
  blockEntityTypeIds: string[],
): string | boolean {
  const pushReaction = block.pushReaction ?? "PushReaction.NORMAL";
  if (block.strength === -1 || pushReaction === "PushReaction.BLOCK") {
    return false;
  }
  if (pushReaction === "PushReaction.DESTROY") {
    return "Breaks";
  }
  if (pushReaction === "PushReaction.PUSH_ONLY") {
    return "Push only";
  }
  if (blockEntityTypeIds.length > 0) {
    return false;
  }
  return true;
}

function pistonStickyValue(block: BlockDefinition, blockEntityTypeIds: string[]): string | boolean {
  const movement = pistonMovementValue(block, blockEntityTypeIds);
  if (movement !== true) {
    return false;
  }
  return true;
}

function blockTagLegacyProperties(tagPaths: Set<string>): Record<string, boolean> {
  const entries = Object.fromEntries(
    Array.from(tagPaths)
      .map((pathValue) => [`tag_${pathValue.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`, true] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  for (const pathValue of tagPaths) {
    const match = pathValue.match(/^mineable\/(.+)$/);
    if (match) {
      entries[`tag_mineable_with_${match[1].replace(/[^a-z0-9]+/g, "_")}`] = true;
    }
  }
  return entries;
}

function fallingBlock(block: BlockDefinition, tagPaths: Set<string>): boolean {
  return (
    /(?:Falling|Sand|Gravel|ConcretePowder|DragonEgg|Anvil)Block$/.test(block.blockClass ?? "") ||
    hasTag(tagPaths, "concrete_powder")
  );
}

function availability(input: {
  block: BlockDefinition;
  itemId: string | null;
  recipeIds: string[];
  lootTable: ParsedLootTable | null;
  tagPaths: Set<string>;
}): BlockPropertySummary["availability"] {
  const reasons: string[] = [];
  if (input.block.air || input.block.noLootTable || !input.itemId) {
    if (input.block.air) reasons.push("air block");
    if (input.block.noLootTable) reasons.push("no loot table");
    if (!input.itemId) reasons.push("no block item");
    return { survivalAvailable: "unobtainable", reasons };
  }
  if (input.recipeIds.length > 0) {
    return { survivalAvailable: "creatable", reasons: ["has recipe for block item"] };
  }
  if (input.lootTable?.itemIds.includes(input.itemId) || fallingBlock(input.block, input.tagPaths)) {
    reasons.push(input.lootTable?.itemIds.includes(input.itemId) ? "drops block item" : "falling block can preserve block state");
    return { survivalAvailable: "obtainable", reasons };
  }
  return { survivalAvailable: "unknown", reasons: ["no recipe/drop inference matched"] };
}

function blockEntityDataDescription(blockEntityTypeIds: string[]): string | null {
  if (blockEntityTypeIds.length === 0) {
    return null;
  }
  return blockEntityTypeIds.map((id) => stripMinecraftNamespace(id)).join(", ");
}

export function deriveBlockProperties(input: {
  blocks: BlocksParseResult | null;
  items: ItemsParseResult | null;
  blockTags: BlockTagsParseResult | null;
  blockEntities: BlockEntitiesParseResult | null;
  blockBehaviors: BlockBehaviorsParseResult | null;
  flammability: FlammabilityParseResult | null;
  lootTables: LootTablesParseResult | null;
  recipes: RecipesParseResult | null;
  worldgenStructures?: WorldgenStructuresParseResult | null;
}): BlockPropertiesParseResult {
  const blocks = input.blocks?.blocks ?? [];
  const diagnostics: ParserDiagnostic[] = [];
  const missingCoverage = LEGACY_PROPERTY_COVERAGE
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.id)
    .sort();
  const partialCoverage = LEGACY_PROPERTY_COVERAGE
    .filter((entry) => entry.status === "partial")
    .map((entry) => entry.id)
    .sort();

  const summaries = blocks.map((block): BlockPropertySummary => {
    const id = block.id ?? normalizeIdentifier(block.fieldName.toLowerCase());
    const state = block.blockStateDefinition;
    const tags = input.blockTags?.blockTagsByBlockId[id] ?? [];
    const tagPathSet = new Set(tags.map(tagPath));
    const item = itemForBlock(input.items, id);
    const lootTable = input.lootTables?.lootTableById[blockLootTableId(id)] ?? null;
    const blockEntityTypes = input.blockEntities?.blockEntityTypesByBlockId[id] ?? [];
    const worldgenStructureSources = input.worldgenStructures?.sourcesByBlockId[id] ?? [];
    const behavior = behaviorForBlock(block, input.blockBehaviors);
    const flammability = input.flammability?.entryByBlockId[id] ?? null;
    const recipeIds = recipeIdsForItem(input.recipes, item?.id ?? null);
    const recipeTypes = recipeTypesForItem(input.recipes, item?.id ?? null);
    const availabilitySummary = availability({
      block,
      itemId: item?.id ?? null,
      recipeIds,
      lootTable,
      tagPaths: tagPathSet,
    });
    const familyTags = {
      mineable: tagsMatching(tagPathSet, "mineable"),
      needsTool: tagsMatching(tagPathSet, ["needs_stone_tool", "needs_iron_tool", "needs_diamond_tool"]),
      incorrectForTool: tagsMatching(tagPathSet, "incorrect_for"),
    };
    const shape = shapeSummary(block);
    const analogOutput = hasBehaviorMethod(behavior, "hasAnalogOutputSignal") || hasBehaviorMethod(behavior, "getAnalogOutputSignal");
    const signalSource = hasBehaviorMethod(behavior, "isSignalSource") || hasBehaviorMethod(behavior, "getSignal") || hasBehaviorMethod(behavior, "getDirectSignal");
    const collisionFullBlock = collisionShapeIsFullBlock(block);
    const outlineFullBlock = outlineShapeIsFullBlock(block);
    const nonSolid = isMostlyNonSolid(block, shape, collisionFullBlock);
    const opaque = legacyOpaque(block, tagPathSet, collisionFullBlock);
    const immuneTagPaths = new Set(tags.map(tagPath));
    const dragonImmune = hasTag(immuneTagPaths, "dragon_immune") || hasTag(immuneTagPaths, "wither_immune");
    const witherImmune = hasTag(immuneTagPaths, "wither_immune") || (block.explosionResistance ?? block.strength ?? 0) >= 1200;
    const waterloggable = legacyWaterloggable(block, state ?? null, tagPathSet);
    const placementSources = placementConditionSources(behavior);
    const entityInteraction = isEntityInteractionBlock(block, behavior, tagPathSet);
    const blockEntityTypeIds = blockEntityTypes.flatMap((entry) => entry.id ? [entry.id] : []);
    const intendedTool = legacyIntendedTool(block, familyTags, lootTable);
    const solidFullShape = collisionFullBlock && !block.air && !block.liquid;
    const opaqueFullShape = solidFullShape && opaque;
    const propagatesSkylightDown = behaviorBooleanOverride(behavior, "propagatesSkylightDown") ?? (!outlineFullBlock && !block.liquid);
    const legacyPathfindable = pathfindableValue({ block, behavior, tagPaths: tagPathSet });
    const canBeWashedAway = Boolean(
      block.noCollision ||
      block.replaceable ||
      hasBehaviorMethod(behavior, "canSurvive") ||
      hasBehaviorMethod(behavior, "mayPlaceOn") ||
      hasTag(tagPathSet, "replaceable"),
    );

    const derivedLegacyProperties = {
      variants: state ? Object.keys(state.propertyValues) : [],
      hardness: block.strength ?? 0,
      blast_resistance: block.explosionResistance ?? block.strength ?? 0,
      instrument: block.instrument ?? "NoteBlockInstrument.HARP",
      map_color: block.mapColor ?? "MapColor.NONE",
      luminance: block.lightLevelExpression ?? 0,
      ignited_by_lava: block.ignitedByLava,
      replaceable: block.replaceable,
      liquid: block.liquid,
      gets_random_ticked: block.randomTicks,
      has_collision: shape.hasCollision,
      exists_as_item: Boolean(item),
      requires_silk_touch: lootRequiresSilkTouchToDropSelf(block, lootTable),
      waterloggable,
      flammable: Boolean(flammability),
      ignite_odds: flammability?.igniteOdds ?? 0,
      burn_odds: flammability?.burnOdds ?? 0,
      falling_block: fallingBlock(block, tagPathSet),
      intended_tool: intendedTool,
      survival_available: availabilitySummary.survivalAvailable,
      block_entity: legacyBlockEntityKind(blockEntityTypeIds, behavior),
      block_entity_data: blockEntityDataDescription(blockEntityTypeIds) ?? "No",
      block_render_type: legacyRenderType(block, shape),
      fluid_render_type: legacyFluidRenderType(block, Boolean(waterloggable)),
      full_cube: solidFullShape,
      height_all: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      height_external: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      width_all: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      width_external: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      collision_bottom_all: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      collision_bottom_external: block.air || shape.hasCollision === false ? "Not Applicable" : solidFullShape ? 16 : null,
      top_face_has_collision: shape.hasCollision === false ? false : solidFullShape ? true : null,
      bottom_face_has_collision: shape.hasCollision === false ? false : solidFullShape ? true : null,
      side_face_has_collision: shape.hasCollision === false ? false : solidFullShape ? true : null,
      top_face_has_full_square: solidFullShape,
      bottom_face_has_full_square: solidFullShape,
      side_face_has_full_square: solidFullShape,
      top_face_has_small_square: shape.hasCollision === true && !shape.returnsEmptyShape,
      bottom_face_has_small_square: shape.hasCollision === true && !shape.returnsEmptyShape,
      top_face_has_rim: solidFullShape || (shape.hasCollision === true && shape.usesState),
      is_opaque_full_cube: opaqueFullShape,
      opaque,
      opacity: legacyOpacity(block, tagPathSet, opaque),
      blocks_skylight: !propagatesSkylightDown,
      blocks_beacon_beam: opaqueFullShape && !hasTag(tagPathSet, "beacon_base_blocks"),
      movable: pistonMovementValue(block, blockEntityTypeIds),
      sticky: pistonStickyValue(block, blockEntityTypeIds),
      xp_dropped_when_mined: lootTable?.functionTypes.includes("minecraft:set_ore_drop_count")
        ? "loot table"
        : lootTable?.functionTypes.some((type) => type.includes("experience"))
          ? "loot table"
          : "None",
      conductive: propertyPredicateValue(block, ["isRedstoneConductor"]) ?? collisionFullBlock,
      redirects_redstone: signalSource || hasBehaviorMethod(behavior, "canConnectRedstone"),
      emits_power: signalSource,
      comparator_output: analogOutput ? methodReturnSources(behavior, ["getAnalogOutputSignal"]) : false,
      sends_comparator_updates: analogOutput || blockEntityTypes.length > 0,
      shape_update_when_powered:
        hasBehaviorMethod(behavior, "neighborChanged") &&
        (signalSource || analogOutput || Boolean(state?.propertyNames.includes("powered"))),
      shape_update_on_interaction: legacyShapeUpdateOnInteraction(behavior),
      shape_update_from_environment: legacyShapeUpdateFromEnvironment(behavior),
      instant_shape_updater: hasBehaviorMethod(behavior, "updateShape"),
      instant_block_updater: hasBehaviorMethod(behavior, "neighborChanged"),
      instant_updater: hasBehaviorMethod(behavior, "updateShape") || hasBehaviorMethod(behavior, "neighborChanged"),
      obstructs_cactus: !block.air && !block.noCollision,
      obstructs_tree_growth: !block.air && !block.noCollision,
      connects_to_panes: !nonSolid || hasTag(tagPathSet, "walls") || hasTag(tagPathSet, "fences"),
      connects_to_walls: !nonSolid || hasTag(tagPathSet, "walls") || hasTag(tagPathSet, "fences"),
      kills_grass: !block.air && !block.noCollision && !block.liquid && !block.replaceable,
      affects_movement_speed: entityInteraction,
      inflicts_damage:
        hasBehaviorMethod(behavior, "entityInside") ||
        hasBehaviorMethod(behavior, "fallOn") ||
        /Cactus|Magma|Campfire|Berry|Dripstone|Anvil|BedBlock/.test(block.blockClass ?? ""),
      dragon_immune: dragonImmune,
      wither_block_break_immune: witherImmune,
      wither_skull_immune: witherImmune,
      suffocates_mobs: propertyPredicateValue(block, ["isSuffocating"]) ?? collisionFullBlock,
      spawnable: propertyPredicateValue(block, ["isValidSpawn"]) ?? (collisionFullBlock && !block.liquid && !block.air),
      raid_spawnable: propertyPredicateValue(block, ["isValidSpawn"]) ?? (collisionFullBlock && !block.liquid && !block.air),
      iron_golem_spawnable_on: propertyPredicateValue(block, ["isValidSpawn"]) ?? (collisionFullBlock && !block.liquid && !block.air),
      gets_destroyed_by_lava: canBeWashedAway || Boolean(flammability),
      gets_flushed: canBeWashedAway,
      instant_mineable: instantMineable(block, intendedTool),
      supports_redstone_dust: collisionFullBlock || hasBehaviorMethod(behavior, "canConnectRedstone"),
      placement_condition: placementSources.length > 0 ? placementSources : false,
      water_forms_source_above: !hasFluidRef(block, "lava") && !block.air && (Boolean(waterloggable) || !block.noCollision || block.liquid),
      pathfindable_through: legacyPathfindable,
      pathfinding_penalty: pathfindingPenalty(legacyPathfindable),
      generates_in_structures: worldgenStructureSources.length > 0,
      numerical_id: null,
      wiki_page: null,
      ...blockTagLegacyProperties(tagPathSet),
    };

    return {
      id,
      fieldName: block.fieldName,
      blockClass: block.blockClass,
      states: {
        propertyNames: state?.propertyNames ?? [],
        propertyValues: state?.propertyValues ?? {},
        variantCount: state?.variants.length ?? 0,
        multipartCount: state?.multipart.length ?? 0,
      },
      tags,
      tagPaths: Array.from(tagPathSet).sort(),
      familyTags,
      item: {
        exists: Boolean(item),
        itemId: item?.id ?? null,
        maxStackSize: item?.maxStackSize ?? null,
        itemClass: item?.itemClass ?? null,
      },
      registrationProperties: {
        mapColor: block.mapColor,
        instrument: block.instrument,
        soundType: block.soundType,
        pushReaction: block.pushReaction,
        hardness: block.strength,
        blastResistance: block.explosionResistance ?? block.strength,
        luminanceExpression: block.lightLevelExpression,
        requiresCorrectToolForDrops: block.requiresCorrectToolForDrops,
        noLootTable: block.noLootTable,
        overrideLootTable: block.overrideLootTable,
        noCollision: block.noCollision,
        noOcclusion: block.noOcclusion,
        replaceable: block.replaceable,
        air: block.air,
        liquid: block.liquid,
        randomTicks: block.randomTicks,
        ignitedByLava: block.ignitedByLava,
        dynamicShape: block.dynamicShape,
        forceSolidOn: block.forceSolidOn,
        forceSolidOff: block.forceSolidOff,
        offsetType: block.offsetType,
      },
      shape,
      loot: {
        lootTableId: lootTable?.id ?? null,
        hasLootTable: Boolean(lootTable),
        droppedItemIds: lootTable?.itemIds ?? [],
        conditionTypes: lootTable?.conditionTypes ?? [],
        functionTypes: lootTable?.functionTypes ?? [],
        requiresSilkTouchToDropSelf: lootRequiresSilkTouchToDropSelf(block, lootTable),
        hasSilkTouchPath: lootTable?.datagenSemantics.hasSilkTouch ?? false,
        hasShearsPath: lootTable?.datagenSemantics.hasShears ?? false,
        hasExplosionCondition: lootTable?.datagenSemantics.hasExplosionCondition ?? false,
        datagenRuleNames: lootTable?.datagenSemantics.ruleNames ?? [],
        datagenHelperNames: lootTable?.datagenSemantics.helperNames ?? [],
        customGenerators: lootTable?.datagenSemantics.customGenerators ?? [],
      },
      crafting: {
        recipeIdsForItem: recipeIds,
        recipeTypesForItem: recipeTypes,
      },
      flammability: {
        flammable: Boolean(flammability),
        igniteOdds: flammability?.igniteOdds ?? null,
        burnOdds: flammability?.burnOdds ?? null,
      },
      blockEntity: {
        hasBlockEntity: blockEntityTypes.length > 0,
        typeIds: blockEntityTypeIds,
        typeFieldNames: blockEntityTypes.map((entry) => entry.fieldName),
      },
      worldgen: {
        generatesInStructures: worldgenStructureSources.length > 0,
        structureSourceIds: Array.from(new Set(worldgenStructureSources.map((source) => source.id))).sort(),
        structureSourceTypes: Array.from(new Set(worldgenStructureSources.map((source) => source.sourceType))).sort(),
      },
      behavior: {
        classChain: behavior?.classChain ?? [],
        methodNames: Object.keys(behavior?.methods ?? {}).sort(),
        signalSource,
        analogOutput,
        placementConditionSources: placementSources,
        pathfindableSources: Array.isArray(legacyPathfindable) ? legacyPathfindable : [legacyPathfindable],
        updateShape: hasBehaviorMethod(behavior, "updateShape"),
        neighborChanged: hasBehaviorMethod(behavior, "neighborChanged"),
        entityInside: hasBehaviorMethod(behavior, "entityInside"),
        stepOn: hasBehaviorMethod(behavior, "stepOn"),
        fallOn: hasBehaviorMethod(behavior, "fallOn"),
        referencedBlockTags: behaviorReferencedTags(behavior),
        referencedBlocks: behaviorReferencedBlocks(behavior),
      },
      availability: availabilitySummary,
      derivedLegacyProperties,
      missingLegacyProperties: missingCoverage,
      diagnostics: [],
    };
  });

  return {
    blocks: summaries,
    blockById: Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
    legacyPropertyCoverage: LEGACY_PROPERTY_COVERAGE,
    missingLegacyProperties: missingCoverage,
    partialLegacyProperties: partialCoverage,
    diagnostics,
  };
}
