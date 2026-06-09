#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  addCreativeModeTabDataTagVariants,
  applyBlockStateDataToBlocks,
  applyBlockShapeDataToBlocks,
  decompileCreativeModeTabReferencedClasses,
  decompileMinecraftClassTargets,
  expandCreativeModeTabsWithResolvedVariants,
  loadLootTablesFromDataRoot,
  loadRecipesFromDataRoot,
  loadWorldgenStructuresFromDataRoot,
  loadBlockTagsFromDataRoot,
  loadBlockStatesFromAssetsRoot,
  loadBlockBehaviorsFromDecompiledRoot,
  compareBlockPropertiesToLegacyData,
  deriveBlockProperties,
  parseBlockFamiliesSource,
  parseBlockEntityTypesSource,
  parseBlocksSource,
  parseBlockShapeClassSources,
  parseCreativeModeTabReferencedVariantData,
  parseCreativeModeTabsSource,
  parseFireBlockSource,
  parseFoodsSource,
  parseItemsSource,
  parsePotionBrewingSource,
  parseTradesSources,
  prepareMinecraftSourceBundle,
  renderMinecraftAssets,
  resolveCreativeModeTabGeneratedVariants,
  type BlockStatesParseResult,
  type BlockShapesParseResult,
  type BlocksParseResult,
  type DecompiledMinecraftClass,
  type MinecraftClassTarget,
  type MinecraftSourceBundle,
} from "./index";
import type { ParserDiagnostic } from "./java/parser-utils";

type CliOptions = {
  version?: string;
  outDir?: string;
  cacheRoot?: string;
  toolCacheRoot?: string;
  forceDecompile: boolean;
  preferFabricUnobfuscated: boolean;
  quiet: boolean;
  help: boolean;
  render: boolean;
  renderConcurrency?: number;
  renderSize?: number;
};

type OutputFile = {
  name: string;
  path: string;
};

type CliDiagnostic = ParserDiagnostic & {
  parser?: string;
};

type ParserOutput = {
  diagnostics?: ParserDiagnostic[];
};

const DEFAULT_OUTPUT_ROOT = path.join("fetcher", "output");
const DEFAULT_BLOCK_SHAPE_DECOMPILE_CONCURRENCY = 6;

function usage(): string {
  return [
    "Usage: npm run fetch:data -- [options]",
    "",
    "Without options, extracts the latest Minecraft release and writes parser JSON to fetcher/output/<version>.",
    "",
    "Options:",
    "  --version <id>        Minecraft version id. Defaults to the latest release.",
    "  --out <dir>           Output directory. Defaults to fetcher/output/<version>.",
    "  --cache-root <dir>    Minecraft download/decompile cache directory.",
    "  --tool-cache-root <dir> CFR/tool cache directory.",
    "  --force-decompile     Re-run CFR even if cached source files already exist.",
    "  --mojang              Use Mojang jars plus official mappings instead of Fabric unobfuscated jars.",
    "  --no-render           Skip item/block PNG rendering.",
    "  --render-concurrency <n> Number of render workers. Defaults to 16.",
    "  --render-size <px>    Rendered PNG size. Defaults to 64.",
    "  --quiet               Suppress progress logging.",
    "  --help                Show this help.",
  ].join("\n");
}

function readOptionValue(args: string[], index: number, name: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return [value, index + 1];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    forceDecompile: false,
    preferFabricUnobfuscated: true,
    quiet: false,
    help: false,
    render: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--force-decompile") {
      options.forceDecompile = true;
      continue;
    }
    if (arg === "--mojang" || arg === "--no-fabric") {
      options.preferFabricUnobfuscated = false;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--no-render") {
      options.render = false;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const key = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : arg.slice(equalsIndex + 1);

    if (key === "--version") {
      if (inlineValue !== null) {
        options.version = inlineValue;
      } else {
        const [value, nextIndex] = readOptionValue(args, index, key);
        options.version = value;
        index = nextIndex;
      }
      continue;
    }
    if (key === "--out" || key === "--output") {
      if (inlineValue !== null) {
        options.outDir = inlineValue;
      } else {
        const [value, nextIndex] = readOptionValue(args, index, key);
        options.outDir = value;
        index = nextIndex;
      }
      continue;
    }
    if (key === "--cache-root") {
      if (inlineValue !== null) {
        options.cacheRoot = inlineValue;
      } else {
        const [value, nextIndex] = readOptionValue(args, index, key);
        options.cacheRoot = value;
        index = nextIndex;
      }
      continue;
    }
    if (key === "--tool-cache-root") {
      if (inlineValue !== null) {
        options.toolCacheRoot = inlineValue;
      } else {
        const [value, nextIndex] = readOptionValue(args, index, key);
        options.toolCacheRoot = value;
        index = nextIndex;
      }
      continue;
    }
    if (key === "--render-concurrency") {
      const rawValue = inlineValue ?? readOptionValue(args, index, key)[0];
      if (inlineValue === null) {
        index += 1;
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
      options.renderConcurrency = value;
      continue;
    }
    if (key === "--render-size") {
      const rawValue = inlineValue ?? readOptionValue(args, index, key)[0];
      if (inlineValue === null) {
        index += 1;
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
      options.renderSize = value;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function createLogger(quiet: boolean): Pick<Console, "log" | "warn"> {
  return quiet
    ? {
        log: () => undefined,
        warn: () => undefined,
      }
    : console;
}

function classSource(bundle: MinecraftSourceBundle, id: string): string | null {
  return bundle.classes[id]?.javaSource ?? null;
}

function classMetadata(classes: Record<string, DecompiledMinecraftClass | null>) {
  return Object.fromEntries(
    Object.entries(classes).map(([id, value]) => [
      id,
      value
        ? {
            classEntry: value.classEntry,
            javaPath: value.javaPath,
            requestedCandidates: value.requestedCandidates,
          }
        : null,
    ]),
  );
}

function cliDiagnostic(input: {
  parser: string;
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}): CliDiagnostic {
  return {
    parser: input.parser,
    code: input.code,
    message: input.message,
    severity: "warning",
    details: input.details,
  };
}

function parseRequiredSource<T extends ParserOutput>(
  input: {
    parser: string;
    classId: string;
    bundle: MinecraftSourceBundle;
    diagnostics: CliDiagnostic[];
  },
  parse: (source: string) => T,
): T | null {
  const source = classSource(input.bundle, input.classId);
  if (!source) {
    input.diagnostics.push(
      cliDiagnostic({
        parser: input.parser,
        code: "cli.source_missing",
        message: `Class source '${input.classId}' was not available for parser '${input.parser}'.`,
        details: { classId: input.classId },
      }),
    );
    return null;
  }

  try {
    return parse(source);
  } catch (error) {
    input.diagnostics.push(
      cliDiagnostic({
        parser: input.parser,
        code: "cli.parser_failed",
        message: `Parser '${input.parser}' failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { classId: input.classId },
      }),
    );
    return null;
  }
}

function collectDiagnostics(parser: string, output: unknown): CliDiagnostic[] {
  if (!output || typeof output !== "object" || !("diagnostics" in output)) {
    return [];
  }

  const diagnostics = (output as ParserOutput).diagnostics;
  if (!Array.isArray(diagnostics)) {
    return [];
  }

  return diagnostics.map((diagnostic) => ({ ...diagnostic, parser }));
}

function blockShapeClassTargets(classNames: string[]): MinecraftClassTarget[] {
  return uniqueClassNames(classNames).map((className) => ({
    id: className,
    candidates: [
      `net/minecraft/world/level/block/${className}.class`,
      `net/minecraft/world/level/block/piston/${className}.class`,
      `net/minecraft/world/level/block/state/${className}.class`,
      `net/minecraft/world/level/block/entity/${className}.class`,
    ],
    required: false,
  }));
}

function uniqueClassNames(classNames: string[]): string[] {
  return Array.from(
    new Set(
      classNames
        .filter((className) => /^[A-Z_$][A-Za-z0-9_$]*$/.test(className))
        .filter((className) => !["WeatheringCopperBlocks"].includes(className)),
    ),
  ).sort();
}

function missingClassDiagnostic(className: string): ParserDiagnostic {
  return {
    code: "block_shapes.class_missing",
    message: `Block shape class '${className}' could not be decompiled.`,
    severity: "warning",
    details: { className },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function cachedBlockShapeSourcePaths(bundle: MinecraftSourceBundle, className: string): string[] {
  const blockRoot = path.join(
    bundle.versionRoot,
    "decompiled",
    "net",
    "minecraft",
    "world",
    "level",
    "block",
  );
  return [
    path.join(blockRoot, `${className}.java`),
    path.join(blockRoot, "piston", `${className}.java`),
    path.join(blockRoot, "state", `${className}.java`),
    path.join(blockRoot, "entity", `${className}.java`),
  ];
}

async function readCachedBlockShapeSources(input: {
  bundle: MinecraftSourceBundle;
  classNames: string[];
  forceDecompile: boolean;
}): Promise<{ cached: Map<string, string>; missing: string[] }> {
  const cached = new Map<string, string>();
  const missing: string[] = [];

  await Promise.all(
    input.classNames.map(async (className) => {
      for (const sourcePath of cachedBlockShapeSourcePaths(input.bundle, className)) {
        if (!input.forceDecompile && await pathExists(sourcePath)) {
          cached.set(className, await readFile(sourcePath, "utf8"));
          return;
        }
      }
      missing.push(className);
    }),
  );

  return { cached, missing: uniqueClassNames(missing) };
}

function blockShapeDecompileConcurrency(): number {
  const configured = Number(process.env.ITEMFETCH_BLOCK_DECOMPILE_CONCURRENCY);
  if (Number.isSafeInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_BLOCK_SHAPE_DECOMPILE_CONCURRENCY;
}

async function loadBlockShapesForBlocks(input: {
  bundle: MinecraftSourceBundle;
  blocks: BlocksParseResult;
  forceDecompile: boolean;
  logger: Pick<Console, "log" | "warn">;
}): Promise<BlockShapesParseResult> {
  const sourceByClassName = new Map<string, string>();
  const missingClassNames = new Set<string>();
  let pending = uniqueClassNames(
    input.blocks.blocks
      .map((block) => block.blockClass)
      .filter((className): className is string => Boolean(className)),
  );

  for (let depth = 0; depth < 8 && pending.length > 0; depth += 1) {
    const cached = await readCachedBlockShapeSources({
      bundle: input.bundle,
      classNames: pending,
      forceDecompile: input.forceDecompile,
    });
    for (const [className, source] of cached.cached) {
      sourceByClassName.set(className, source);
    }

    if (cached.cached.size > 0) {
      input.logger.log(`Loaded ${cached.cached.size} cached block shape class sources.`);
    }

    if (cached.missing.length > 0) {
      input.logger.log(
        `Decompiling ${cached.missing.length} missing block shape classes with concurrency ${blockShapeDecompileConcurrency()}...`,
      );
    }

    const decompiled = cached.missing.length === 0
      ? {}
      : await decompileMinecraftClassTargets(
        input.bundle,
        blockShapeClassTargets(cached.missing),
        {
          forceDecompile: input.forceDecompile,
          concurrency: blockShapeDecompileConcurrency(),
          logger: input.logger,
        },
      );

    for (const [className, decompiledClass] of Object.entries(decompiled)) {
      if (decompiledClass) {
        sourceByClassName.set(className, decompiledClass.javaSource);
      } else {
        missingClassNames.add(className);
      }
    }

    const parsed = parseBlockShapeClassSources(Array.from(sourceByClassName.values()));
    pending = uniqueClassNames(
      parsed.classes
        .map((entry) => entry.superClassName)
        .filter((className): className is string => Boolean(className))
        .filter((className) => className !== "Block")
        .filter((className) => !sourceByClassName.has(className))
        .filter((className) => !missingClassNames.has(className)),
    );
  }

  const result = parseBlockShapeClassSources(Array.from(sourceByClassName.values()));
  result.diagnostics.push(...Array.from(missingClassNames).sort().map(missingClassDiagnostic));
  return result;
}

async function writeJson(outDir: string, name: string, value: unknown): Promise<OutputFile> {
  const filePath = path.join(outDir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { name, path: filePath };
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const logger = createLogger(options.quiet);
  logger.log(`Preparing Minecraft source bundle for ${options.version ?? "latest release"}...`);
  const bundle = await prepareMinecraftSourceBundle({
    version: options.version,
    cacheRoot: options.cacheRoot,
    toolCacheRoot: options.toolCacheRoot,
    forceDecompile: options.forceDecompile,
    preferFabricUnobfuscated: options.preferFabricUnobfuscated,
    logger,
  });

  const outDir = path.resolve(options.outDir ?? path.join(DEFAULT_OUTPUT_ROOT, bundle.displayVersion));
  await mkdir(outDir, { recursive: true });

  const cliDiagnostics: CliDiagnostic[] = [];
  logger.log(`Parsing ${bundle.displayVersion} data...`);

  let blocks = parseRequiredSource(
    { parser: "blocks", classId: "blocks", bundle, diagnostics: cliDiagnostics },
    parseBlocksSource,
  );
  let items = parseRequiredSource(
    { parser: "items", classId: "items", bundle, diagnostics: cliDiagnostics },
    parseItemsSource,
  );
  const foods = parseRequiredSource(
    { parser: "foods", classId: "foods", bundle, diagnostics: cliDiagnostics },
    parseFoodsSource,
  );
  const creativeModeTabs = parseRequiredSource(
    { parser: "creativeModeTabs", classId: "creativeModeTabs", bundle, diagnostics: cliDiagnostics },
    parseCreativeModeTabsSource,
  );
  const blockFamilies = parseRequiredSource(
    { parser: "blockFamilies", classId: "blockFamilies", bundle, diagnostics: cliDiagnostics },
    parseBlockFamiliesSource,
  );
  const blockEntities = parseRequiredSource(
    { parser: "blockEntities", classId: "blockEntityTypes", bundle, diagnostics: cliDiagnostics },
    parseBlockEntityTypesSource,
  );
  const flammability = parseRequiredSource(
    { parser: "flammability", classId: "fireBlock", bundle, diagnostics: cliDiagnostics },
    parseFireBlockSource,
  );
  const brewing = parseRequiredSource(
    { parser: "brewing", classId: "potionBrewing", bundle, diagnostics: cliDiagnostics },
    parsePotionBrewingSource,
  );

  let blockShapes: BlockShapesParseResult | null = null;
  let blockStates: BlockStatesParseResult | null = null;
  let blockBehaviors: Awaited<ReturnType<typeof loadBlockBehaviorsFromDecompiledRoot>> | null = null;
  if (blocks) {
    blockShapes = await loadBlockShapesForBlocks({
      bundle,
      blocks,
      forceDecompile: options.forceDecompile,
      logger,
    });
    blocks = applyBlockShapeDataToBlocks(blocks, blockShapes);

    blockStates = bundle.assetsRoot
      ? await loadBlockStatesFromAssetsRoot({ assetsRoot: bundle.assetsRoot })
      : {
          blockStates: [],
          blockStateById: {},
          variantCount: 0,
          multipartCount: 0,
          propertyValueCounts: {},
          diagnostics: [
            cliDiagnostic({
              parser: "blockStates",
              code: "cli.assets_root_missing",
              message: "No extracted assets root was available for blockstate parsing.",
            }),
          ],
        };
    blocks = applyBlockStateDataToBlocks(blocks, blockStates);

    blockBehaviors = await loadBlockBehaviorsFromDecompiledRoot({
      decompiledRoot: path.join(bundle.versionRoot, "decompiled"),
    });
  }

  const trades = parseTradesSources({
    villagerTradesSource: classSource(bundle, "villagerTrades") ?? undefined,
    tradeRebalanceVillagerTradesSource:
      classSource(bundle, "tradeRebalanceVillagerTrades") ?? undefined,
    villagerTradeTagsSource: classSource(bundle, "villagerTradeTags") ?? undefined,
    villagerTradesTagsProviderSource: classSource(bundle, "villagerTradesTagsProvider") ?? undefined,
    tradeRebalanceTradeTagsProviderSource:
      classSource(bundle, "tradeRebalanceTradeTagsProvider") ?? undefined,
    tradeSetsSource: classSource(bundle, "tradeSets") ?? undefined,
    villagerProfessionSource: classSource(bundle, "villagerProfession") ?? undefined,
    villagerSource: classSource(bundle, "villager") ?? undefined,
    wanderingTraderSource: classSource(bundle, "wanderingTrader") ?? undefined,
  });

  let renderings: Awaited<ReturnType<typeof renderMinecraftAssets>>["renderings"] | null = null;
  if (options.render && items && blocks && bundle.assetsRoot) {
    logger.log("Rendering item and block images...");
    const rendered = await renderMinecraftAssets({
      items,
      blocks,
      blockStates,
      options: {
        assetsRoot: bundle.assetsRoot,
        outputRoot: path.join(outDir, "renderings"),
        publicPathPrefix: "renderings",
        specialTextureRoot: path.resolve(process.cwd(), "itemfetch", "special"),
        concurrency: options.renderConcurrency ?? Number(process.env.ITEMFETCH_RENDER_CONCURRENCY ?? "16"),
        size: options.renderSize ?? Number(process.env.ITEMFETCH_RENDER_SIZE ?? "64"),
        supersample: Number(process.env.ITEMFETCH_RENDER_SUPERSAMPLE ?? "2"),
        logger,
      },
    });
    items = rendered.items;
    blocks = rendered.blocks;
    renderings = rendered.renderings;
  } else if (options.render && !bundle.assetsRoot) {
    cliDiagnostics.push(
      cliDiagnostic({
        parser: "renderings",
        code: "cli.assets_root_missing",
        message: "No extracted assets root was available for rendering.",
      }),
    );
  }

  let creativeModeTabVariants: unknown = null;
  let creativeModeTabsExpanded: unknown = null;
  if (creativeModeTabs) {
    logger.log("Resolving creative mode tab generated variants...");
    const referencedClasses = await decompileCreativeModeTabReferencedClasses(bundle, {
      forceDecompile: options.forceDecompile,
      logger,
    });
    const referencedData = await addCreativeModeTabDataTagVariants(
      bundle,
      parseCreativeModeTabReferencedVariantData(referencedClasses),
    );
    const resolvedVariants = resolveCreativeModeTabGeneratedVariants(creativeModeTabs, referencedData);
    creativeModeTabsExpanded = expandCreativeModeTabsWithResolvedVariants(
      creativeModeTabs,
      resolvedVariants,
    );
    creativeModeTabVariants = {
      referencedClasses: classMetadata(referencedClasses),
      referencedData,
      resolvedVariants,
      diagnostics: [
        ...referencedData.diagnostics,
        ...resolvedVariants
          .map((variant) => variant.diagnostic)
          .filter((diagnostic): diagnostic is ParserDiagnostic => diagnostic !== null),
      ],
    };
  }

  const dataRoot = bundle.serverDataRoot ?? bundle.assetsRoot;
  const recipes = dataRoot
    ? await loadRecipesFromDataRoot({ dataRoot })
    : {
        recipes: [],
        recipeById: {},
        recipeTypeCounts: {},
        diagnostics: [
          cliDiagnostic({
            parser: "recipes",
            code: "cli.data_root_missing",
            message: "No extracted data root was available for recipe parsing.",
          }),
        ],
      };
  const lootTables = dataRoot
    ? await loadLootTablesFromDataRoot({
        dataRoot,
        datagenSourceRoot: path.join(bundle.versionRoot, "decompiled", "net", "minecraft", "data", "loot", "packs"),
      })
    : {
        lootTables: [],
        lootTableById: {},
        datagen: null,
        tableTypeCounts: {},
        categoryCounts: {},
        entryTypeCounts: {},
        functionTypeCounts: {},
        conditionTypeCounts: {},
        diagnostics: [
          cliDiagnostic({
            parser: "lootTables",
            code: "cli.data_root_missing",
            message: "No extracted data root was available for loot table parsing.",
          }),
        ],
      };
  const blockTags = dataRoot
    ? await loadBlockTagsFromDataRoot({ dataRoot })
    : {
        tags: [],
        tagById: {},
        blockTagsByBlockId: {},
        diagnostics: [
          cliDiagnostic({
            parser: "blockTags",
            code: "cli.data_root_missing",
            message: "No extracted data root was available for block tag parsing.",
          }),
        ],
      };
  const worldgenStructures = dataRoot && blocks
    ? await loadWorldgenStructuresFromDataRoot({
        dataRoot,
        knownBlockIds: blocks.blocks.flatMap((block) => block.id ? [block.id] : []),
      })
    : {
        blockIds: [],
        sourcesByBlockId: {},
        structureTemplateCount: 0,
        processorListCount: 0,
        diagnostics: [
          cliDiagnostic({
            parser: "worldgenStructures",
            code: "cli.data_root_missing",
            message: "No extracted data root or block list was available for worldgen structure parsing.",
          }),
        ],
      };
  const blockProperties = deriveBlockProperties({
    blocks,
    items,
    blockTags,
    blockEntities,
    blockBehaviors,
    flammability,
    lootTables,
    recipes,
    worldgenStructures,
  });
  const legacyComparison = await compareBlockPropertiesToLegacyData({
    blockProperties,
    manualDataPath: path.resolve(process.cwd(), "block_data.json"),
  });

  const outputs: Record<string, unknown> = {
    "blocks.json": blocks,
    "block-shapes.json": blockShapes,
    "block-states.json": blockStates,
    "block-tags.json": blockTags,
    "block-entities.json": blockEntities,
    "block-behaviors.json": blockBehaviors,
    "block-properties.json": blockProperties,
    "legacy-comparison.json": legacyComparison,
    "renderings.json": renderings,
    "items.json": items,
    "foods.json": foods,
    "creative-mode-tabs.json": creativeModeTabs,
    "creative-mode-tab-variants.json": creativeModeTabVariants,
    "creative-mode-tabs-expanded.json": creativeModeTabsExpanded,
    "block-families.json": blockFamilies,
    "brewing.json": brewing,
    "flammability.json": flammability,
    "recipes.json": recipes,
    "loot-tables.json": lootTables,
    "worldgen-structures.json": worldgenStructures,
    "trades.json": trades,
  };

  const parserDiagnostics = [
    ...cliDiagnostics,
    ...Object.entries(outputs).flatMap(([fileName, output]) =>
      collectDiagnostics(fileName.replace(/\.json$/, ""), output),
    ),
  ];
  const diagnosticCounts = parserDiagnostics.reduce<Record<string, number>>((counts, diagnostic) => {
    const severity = diagnostic.severity ?? "warning";
    counts[severity] = (counts[severity] ?? 0) + 1;
    return counts;
  }, {});

  const metadata = {
    generatedAt: new Date().toISOString(),
    version: bundle.displayVersion,
    sourceVersion: bundle.version,
    provider: bundle.provider,
    manifestUrl: bundle.manifestUrl,
    dataRoot,
    assetsRoot: bundle.assetsRoot,
    serverDataRoot: bundle.serverDataRoot,
    classSources: classMetadata(bundle.classes),
    counts: {
      blocks: blocks?.blocks.length ?? 0,
      blockShapeClasses: blockShapes?.classes.length ?? 0,
      blockStates: blockStates?.blockStates.length ?? 0,
      blockStateVariants: blockStates?.variantCount ?? 0,
      blockStateMultipartEntries: blockStates?.multipartCount ?? 0,
      blockTags: blockTags.tags.length,
      blockEntityTypes: blockEntities?.blockEntityTypes.length ?? 0,
      blockBehaviorClasses: blockBehaviors?.classes.length ?? 0,
      blockBehaviorResolvedClasses: blockBehaviors ? Object.keys(blockBehaviors.resolvedByClassName).length : 0,
      blockProperties: blockProperties.blocks.length,
      legacyComparisonMismatches: legacyComparison.mismatchCount,
      legacyComparisonCompared: legacyComparison.comparedCount,
      flammabilityEntries: flammability?.entries.length ?? 0,
      itemRenderings: renderings?.counts.itemsRendered ?? 0,
      blockRenderings: renderings?.counts.blocksRendered ?? 0,
      missingItemRenderings: renderings?.counts.itemsMissing ?? 0,
      missingBlockRenderings: renderings?.counts.blocksMissing ?? 0,
      specialRenderings: renderings?.counts.specialRendered ?? 0,
      items: items?.items.length ?? 0,
      foods: foods?.foods.length ?? 0,
      creativeModeTabs: creativeModeTabs?.tabs.length ?? 0,
      creativeModeTabGeneratedVariants:
        creativeModeTabVariants && typeof creativeModeTabVariants === "object" && "resolvedVariants" in creativeModeTabVariants
          ? (creativeModeTabVariants["resolvedVariants"] as unknown[]).length
          : 0,
      blockFamilies: blockFamilies?.families.length ?? 0,
      brewingRecipes:
        (brewing?.containerRecipes.length ?? 0) +
        (brewing?.potionMixes.length ?? 0) +
        (brewing?.startMixes.length ?? 0),
      recipes: recipes.recipes.length,
      lootTables: lootTables.lootTables.length,
      worldgenStructureBlocks: worldgenStructures.blockIds.length,
      worldgenStructureTemplates: worldgenStructures.structureTemplateCount,
      worldgenStructureProcessors: worldgenStructures.processorListCount,
      trades: trades.trades.length,
      diagnostics: parserDiagnostics.length,
    },
    diagnosticCounts,
  };

  const writtenFiles: OutputFile[] = [];
  writtenFiles.push(await writeJson(outDir, "metadata.json", metadata));
  for (const [name, value] of Object.entries(outputs)) {
    writtenFiles.push(await writeJson(outDir, name, value));
  }
  writtenFiles.push(
    await writeJson(outDir, "diagnostics.json", {
      counts: diagnosticCounts,
      diagnostics: parserDiagnostics,
    }),
  );
  const manifestFile = { name: "manifest.json", path: path.join(outDir, "manifest.json") };
  await writeJson(outDir, "manifest.json", {
    ...metadata,
    outputFiles: [...writtenFiles, manifestFile],
  });

  console.log(
    `Extracted Minecraft ${bundle.displayVersion}: ${metadata.counts.items} items, ${metadata.counts.blocks} blocks, ${metadata.counts.recipes} recipes, ${metadata.counts.lootTables} loot tables, ${metadata.counts.trades} trades.`,
  );
  console.log(`Wrote ${writtenFiles.length + 1} JSON files to ${outDir}`);
  if (parserDiagnostics.length > 0) {
    console.log(`Diagnostics: ${parserDiagnostics.length}`);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
