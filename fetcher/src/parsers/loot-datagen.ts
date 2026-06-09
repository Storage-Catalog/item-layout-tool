import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";
import {
  findMatchingToken,
  findStatementEnd,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  unique,
} from "../java/parser-utils";
import { tokenizeJava } from "../java/tokenizer";

export type LootDatagenTargetKind = "block" | "entity" | "built_in_table" | "unknown";

export type LootDatagenRule = {
  tableId: string | null;
  targetKind: LootDatagenTargetKind;
  targetId: string | null;
  sourceClass: string;
  sourceFile: string;
  sourceLine: number;
  ruleName: string;
  sourceSnippet: string;
  blockIds: string[];
  itemIds: string[];
  entityTypeIds: string[];
  builtInLootTableConstants: string[];
  helperNames: string[];
  hasNoDrop: boolean;
  hasDropSelf: boolean;
  hasOtherWhenSilkTouch: boolean;
  hasDropWhenSilkTouch: boolean;
  hasSilkTouch: boolean;
  hasShears: boolean;
  hasExplosionCondition: boolean;
  customGenerator: string | null;
  diagnostics: ParserDiagnostic[];
};

export type LootDatagenParseResult = {
  rules: LootDatagenRule[];
  rulesByTableId: Record<string, LootDatagenRule[]>;
  ruleNameCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

export type LootDatagenParseOptions = {
  sourceRoot: string;
  knownLootTableIds?: string[];
};

const SOURCE_CLASS_CATEGORY_HINTS: Array<[RegExp, string[]]> = [
  [/BlockLoot/, ["blocks"]],
  [/EntityLoot/, ["entities"]],
  [/ChestLoot/, ["chests", "dispensers", "pots", "spawners"]],
  [/FishingLoot/, ["gameplay/fishing", "gameplay"]],
  [/GiftLoot/, ["gameplay/hero_of_the_village", "gameplay"]],
  [/PiglinBarterLoot/, ["gameplay"]],
  [/ArchaeologyLoot/, ["archaeology"]],
  [/ShearingLoot/, ["shearing"]],
  [/EquipmentLoot/, ["equipment"]],
  [/BlockInteractLoot/, ["harvest", "carve"]],
  [/EntityInteractLoot/, ["brush"]],
  [/ChargedCreeperExplosionLoot/, ["charged_creeper"]],
];

const HELPER_NAME_RE = /\b(?:this\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const BLOCK_REF_RE = /\bBlocks\.([A-Z0-9_]+)\b/g;
const ITEM_REF_RE = /\bItems\.([A-Z0-9_]+)\b/g;
const ENTITY_TYPE_REF_RE = /\bEntityType\.([A-Z0-9_]+)\b/g;
const BUILT_IN_LOOT_TABLE_RE = /\bBuiltInLootTables\.([A-Z0-9_]+)\b/g;
const ALLOWED_EXTRA_CONSTANT_WORDS = new Set(["villager"]);

function diagnostic(input: {
  code: string;
  message: string;
  source?: string;
  details?: Record<string, string | number | boolean | null>;
}): ParserDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: "warning",
    source: input.source,
    details: input.details,
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function toMinecraftId(name: string): string {
  return `minecraft:${name.toLowerCase()}`;
}

function toPathName(name: string): string {
  return name.toLowerCase();
}

function splitIdentifierWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\/_:]+/)
    .flatMap((part) => part.split("_"))
    .filter(Boolean)
    .map((word) => {
      if (word === "shearing") {
        return "shear";
      }
      return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
    });
}

function sameWordSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((word, index) => word === rightSorted[index]);
}

function collectRegexValues(source: string, regex: RegExp): string[] {
  const values: string[] = [];
  regex.lastIndex = 0;
  for (const match of source.matchAll(regex)) {
    values.push(match[1]);
  }
  return unique(values);
}

function collectHelperNames(source: string): string[] {
  const names = collectRegexValues(source, HELPER_NAME_RE);
  return names.filter((name) => (
    name.startsWith("create") ||
    name.startsWith("add") ||
    name.startsWith("drop") ||
    name === "noDrop" ||
    name === "otherWhenSilkTouch" ||
    name === "applyExplosionCondition" ||
    name === "applyExplosionDecay" ||
    name === "hasSilkTouch" ||
    name === "hasShears" ||
    name === "doesNotHaveSilkTouch" ||
    name === "doesNotHaveShearsOrSilkTouch"
  ));
}

function classNameFromSource(source: string, fallback: string): string {
  return /\b(?:class|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(source)?.[1] ?? fallback;
}

function pathExistsInput(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function pathExists(directory: string): Promise<boolean> {
  try {
    await readdir(directory);
    return true;
  } catch (error) {
    if (pathExistsInput(error)) {
      return false;
    }
    throw error;
  }
}

async function collectJavaFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectJavaFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".java") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

function categoryHintsForSourceClass(sourceClass: string): string[] {
  return SOURCE_CLASS_CATEGORY_HINTS.find(([pattern]) => pattern.test(sourceClass))?.[1] ?? [];
}

function resolveBuiltInLootTableId(
  constant: string,
  sourceClass: string,
  knownLootTableIds: Set<string>,
): string | null {
  if (knownLootTableIds.size === 0) {
    return null;
  }

  const constantPath = toPathName(constant);
  const suffixMatches = [...knownLootTableIds].filter((id) => {
    const tablePath = id.split(":")[1] ?? id;
    return tablePath === constantPath || tablePath.endsWith(`/${constantPath}`);
  });
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  const hints = categoryHintsForSourceClass(sourceClass);
  const hintedMatches = suffixMatches.filter((id) => {
    const tablePath = id.split(":")[1] ?? id;
    return hints.some((hint) => tablePath === `${hint}/${constantPath}` || tablePath.startsWith(`${hint}/`));
  });
  if (hintedMatches.length === 1) {
    return hintedMatches[0];
  }

  const exactHintMatches = hints
    .map((hint) => `minecraft:${hint}/${constantPath}`)
    .filter((id) => knownLootTableIds.has(id));
  if (exactHintMatches.length === 1) {
    return exactHintMatches[0];
  }

  const constantWords = splitIdentifierWords(constant);
  const wordSetMatches = [...knownLootTableIds].filter((id) => {
    const tablePath = id.split(":")[1] ?? id;
    return sameWordSet(constantWords, splitIdentifierWords(tablePath));
  });
  if (wordSetMatches.length === 1) {
    return wordSetMatches[0];
  }

  const hintedWordSetMatches = wordSetMatches.filter((id) => {
    const tablePath = id.split(":")[1] ?? id;
    return hints.some((hint) => tablePath.startsWith(`${hint}/`) || tablePath === hint);
  });
  if (hintedWordSetMatches.length === 1) {
    return hintedWordSetMatches[0];
  }

  const rootHintMatch = hints
    .map((hint) => ({ hint, id: `minecraft:${hint}/root` }))
    .find(({ hint, id }) => knownLootTableIds.has(id) && sameWordSet(constantWords, splitIdentifierWords(hint)));
  if (rootHintMatch) {
    return rootHintMatch.id;
  }

  const hintedSubsetMatches = [...knownLootTableIds].filter((id) => {
    const tablePath = id.split(":")[1] ?? id;
    if (!hints.some((hint) => tablePath.startsWith(`${hint}/`) || tablePath === hint)) {
      return false;
    }
    const pathWords = splitIdentifierWords(tablePath);
    const hintWords = hints.flatMap(splitIdentifierWords);
    const extraConstantWords = constantWords.filter((word) => !pathWords.includes(word));
    const extraPathWords = pathWords.filter((word) => !constantWords.includes(word) && !hintWords.includes(word));
    return (
      extraConstantWords.every((word) => ALLOWED_EXTRA_CONSTANT_WORDS.has(word)) &&
      extraPathWords.every((word) => word === "chamber" && constantWords.includes("trial"))
    );
  });
  if (hintedSubsetMatches.length === 1) {
    return hintedSubsetMatches[0];
  }
  for (const hint of hints) {
    const matchesForHint = hintedSubsetMatches.filter((id) => {
      const tablePath = id.split(":")[1] ?? id;
      return tablePath.startsWith(`${hint}/`) || tablePath === hint;
    });
    if (matchesForHint.length === 1) {
      return matchesForHint[0];
    }
  }

  return null;
}

function resolveTargetFromSnippet(input: {
  ruleName: string;
  snippet: string;
  sourceClass: string;
  knownLootTableIds: Set<string>;
}): Pick<LootDatagenRule, "tableId" | "targetKind" | "targetId" | "customGenerator"> {
  const blockConstants = collectRegexValues(input.snippet, BLOCK_REF_RE);
  const entityConstants = collectRegexValues(input.snippet, ENTITY_TYPE_REF_RE);
  const builtInConstants = collectRegexValues(input.snippet, BUILT_IN_LOOT_TABLE_RE);

  if (
    input.ruleName === "dropSelf" ||
    input.ruleName === "dropWhenSilkTouch" ||
    input.ruleName === "otherWhenSilkTouch" ||
    input.ruleName === "addNetherVinesDropTable"
  ) {
    const target = blockConstants[0] ?? null;
    const targetId = target ? toMinecraftId(target) : null;
    return {
      tableId: target ? `minecraft:blocks/${toPathName(target)}` : null,
      targetKind: "block",
      targetId,
      customGenerator: null,
    };
  }

  if (input.ruleName === "add" && /\bEntityType\./.test(input.snippet)) {
    const target = entityConstants[0] ?? null;
    return {
      tableId: target ? `minecraft:entities/${toPathName(target)}` : null,
      targetKind: "entity",
      targetId: target ? toMinecraftId(target) : null,
      customGenerator: null,
    };
  }

  if (input.ruleName === "add" && /\bBlocks\./.test(input.snippet)) {
    const target = blockConstants[0] ?? null;
    const helperNames = collectHelperNames(input.snippet);
    return {
      tableId: target ? `minecraft:blocks/${toPathName(target)}` : null,
      targetKind: "block",
      targetId: target ? toMinecraftId(target) : null,
      customGenerator: helperNames.find((name) => name.startsWith("create") || name.startsWith("lambda$")) ?? null,
    };
  }

  if (input.ruleName === "accept" && builtInConstants[0]) {
    const tableId = resolveBuiltInLootTableId(builtInConstants[0], input.sourceClass, input.knownLootTableIds);
    return {
      tableId,
      targetKind: "built_in_table",
      targetId: tableId,
      customGenerator: null,
    };
  }

  return {
    tableId: null,
    targetKind: "unknown",
    targetId: null,
    customGenerator: null,
  };
}

function isExpectedDynamicUnresolved(input: {
  ruleName: string;
  snippet: string;
  builtInLootTableConstants: string[];
}): boolean {
  return (
    /\(Block\)\s*block\b/.test(input.snippet) ||
    /\bentry\.lootTable\b/.test(input.snippet) ||
    /\bBuiltInLootTables\.[A-Z0-9_]+\.get\s*\(/.test(input.snippet) ||
    (input.ruleName === "accept" && input.builtInLootTableConstants.length === 0)
  );
}

function parseRuleInvocation(input: {
  source: string;
  sourceClass: string;
  sourceFile: string;
  knownLootTableIds: Set<string>;
  methodIndex: number;
  tokens: ReturnType<typeof tokenizeJava>;
}): LootDatagenRule | null {
  const methodToken = input.tokens[input.methodIndex];
  const openIndex = input.methodIndex + 1;
  if (!methodToken || input.tokens[openIndex]?.value !== "(") {
    return null;
  }

  const ruleName = methodToken.value;
  if (!["add", "accept", "dropSelf", "dropWhenSilkTouch", "otherWhenSilkTouch", "addNetherVinesDropTable"].includes(ruleName)) {
    return null;
  }

  if (
    ruleName === "accept" &&
    input.tokens[input.methodIndex - 2]?.value !== "output"
  ) {
    return null;
  }
  if (
    ruleName !== "accept" &&
    input.tokens[input.methodIndex - 2]?.value !== "this"
  ) {
    return null;
  }

  const closeIndex = findMatchingToken(input.tokens, openIndex);
  if (closeIndex === -1) {
    return null;
  }

  const statementEnd = findStatementEnd(input.tokens, input.methodIndex);
  const endIndex = statementEnd === -1 ? closeIndex + 1 : statementEnd + 1;
  const snippet = tokenSource(input.source, input.tokens, input.methodIndex - 2, endIndex);
  const args = splitTopLevelArguments(input.tokens, openIndex + 1, closeIndex);
  const firstArg = args[0] ? tokenSource(input.source, input.tokens, args[0].startIndex, args[0].endIndex) : "";
  const target = resolveTargetFromSnippet({
    ruleName,
    snippet,
    sourceClass: input.sourceClass,
    knownLootTableIds: input.knownLootTableIds,
  });
  const helperNames = collectHelperNames(snippet);
  const blockIds = collectRegexValues(snippet, BLOCK_REF_RE).map(toMinecraftId);
  const itemIds = collectRegexValues(snippet, ITEM_REF_RE).map(toMinecraftId);
  const entityTypeIds = collectRegexValues(snippet, ENTITY_TYPE_REF_RE).map(toMinecraftId);
  const builtInLootTableConstants = collectRegexValues(snippet, BUILT_IN_LOOT_TABLE_RE);
  const diagnostics: ParserDiagnostic[] = [];

  if (!target.tableId && !isExpectedDynamicUnresolved({ ruleName, snippet, builtInLootTableConstants })) {
    diagnostics.push(
      diagnostic({
        code: "loot.datagen_table_unresolved",
        message: `Could not resolve datagen loot table target for '${input.sourceClass}.${ruleName}'.`,
        source: input.sourceFile,
        details: {
          sourceClass: input.sourceClass,
          ruleName,
          line: methodToken.line,
        },
      }),
    );
  }

  if (args.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "loot.datagen_missing_arguments",
        message: `Datagen call '${input.sourceClass}.${ruleName}' has no arguments.`,
        source: input.sourceFile,
        details: {
          sourceClass: input.sourceClass,
          ruleName,
          line: methodToken.line,
        },
      }),
    );
  }

  return {
    ...target,
    sourceClass: input.sourceClass,
    sourceFile: input.sourceFile,
    sourceLine: methodToken.line,
    ruleName,
    sourceSnippet: snippet,
    blockIds: unique(blockIds),
    itemIds: unique(itemIds),
    entityTypeIds: unique(entityTypeIds),
    builtInLootTableConstants,
    helperNames,
    hasNoDrop: /\bnoDrop\s*\(/.test(snippet),
    hasDropSelf: ruleName === "dropSelf",
    hasOtherWhenSilkTouch: ruleName === "otherWhenSilkTouch",
    hasDropWhenSilkTouch: ruleName === "dropWhenSilkTouch",
    hasSilkTouch: /SilkTouch/.test(snippet),
    hasShears: /Shears/.test(snippet),
    hasExplosionCondition: /Explosion/.test(snippet),
    customGenerator: target.customGenerator ?? (/::\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(snippet)?.[1] ?? null),
    diagnostics,
  };
}

export function parseLootDatagenJava(input: {
  source: string;
  sourceFile: string;
  knownLootTableIds?: string[];
}): LootDatagenParseResult {
  const tokens = tokenizeJava(input.source);
  const fallbackClass = path.basename(input.sourceFile, ".java");
  const sourceClass = classNameFromSource(input.source, fallbackClass);
  const knownLootTableIds = new Set(input.knownLootTableIds ?? []);
  const rules: LootDatagenRule[] = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1]?.value !== "(") {
      continue;
    }
    const rule = parseRuleInvocation({
      source: input.source,
      sourceClass,
      sourceFile: input.sourceFile,
      knownLootTableIds,
      methodIndex: index,
      tokens,
    });
    if (rule) {
      rules.push(rule);
    }
  }

  const diagnostics: ParserDiagnostic[] = rules.flatMap((rule) => rule.diagnostics);
  for (const rule of rules) {
    if (rule.sourceSnippet.length > 10000) {
      diagnostics.push({
        code: "loot.datagen_large_statement",
        message: `Datagen rule '${rule.sourceClass}.${rule.ruleName}' has a very large generated statement; use JSON for exact pool details.`,
        severity: "info",
        source: rule.sourceFile,
        range: tokenRange(tokens, 0, Math.min(tokens.length, 1)),
        details: {
          sourceClass: rule.sourceClass,
          ruleName: rule.ruleName,
          line: rule.sourceLine,
        },
      });
    }
  }

  return summarizeLootDatagenRules(rules, diagnostics);
}

function summarizeLootDatagenRules(
  rules: LootDatagenRule[],
  diagnostics: ParserDiagnostic[] = rules.flatMap((rule) => rule.diagnostics),
): LootDatagenParseResult {
  const rulesByTableId: Record<string, LootDatagenRule[]> = {};
  for (const rule of rules) {
    if (!rule.tableId) {
      continue;
    }
    rulesByTableId[rule.tableId] ??= [];
    rulesByTableId[rule.tableId].push(rule);
  }

  return {
    rules,
    rulesByTableId,
    ruleNameCounts: countBy(rules.map((rule) => rule.ruleName)),
    diagnostics,
  };
}

export async function loadLootDatagenFromSourceRoot(
  input: LootDatagenParseOptions,
): Promise<LootDatagenParseResult> {
  if (!(await pathExists(input.sourceRoot))) {
    return {
      rules: [],
      rulesByTableId: {},
      ruleNameCounts: {},
      diagnostics: [
        diagnostic({
          code: "loot.datagen_directory_missing",
          message: `Could not find loot datagen source directory '${input.sourceRoot}'.`,
          details: { sourceRoot: input.sourceRoot },
        }),
      ],
    };
  }

  const files = (await collectJavaFiles(input.sourceRoot)).sort();
  const parsed = await Promise.all(
    files.map(async (filePath) => parseLootDatagenJava({
      source: await readFile(filePath, "utf8"),
      sourceFile: filePath,
      knownLootTableIds: input.knownLootTableIds,
    })),
  );
  return summarizeLootDatagenRules(
    parsed.flatMap((result) => result.rules),
    parsed.flatMap((result) => result.diagnostics),
  );
}
