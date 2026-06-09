import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";
import type { BlocksParseResult } from "./blocks";

export type BlockStateJsonPrimitive = string | number | boolean | null;
export type BlockStateJsonValue =
  | BlockStateJsonPrimitive
  | BlockStateJsonValue[]
  | { [key: string]: BlockStateJsonValue };
export type BlockStateJsonObject = { [key: string]: BlockStateJsonValue };

export type BlockStateModelDefinition = {
  model: string | null;
  x: number | null;
  y: number | null;
  uvlock: boolean | null;
  weight: number | null;
  raw: BlockStateJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedBlockStateVariant = {
  stateKey: string;
  properties: Record<string, string>;
  models: BlockStateModelDefinition[];
  raw: BlockStateJsonValue;
  diagnostics: ParserDiagnostic[];
};

export type BlockStateMultipartCondition =
  | {
      kind: "properties";
      properties: Record<string, string[]>;
      raw: BlockStateJsonObject;
    }
  | {
      kind: "or" | "and";
      terms: BlockStateMultipartCondition[];
      raw: BlockStateJsonObject;
    }
  | {
      kind: "unknown";
      raw: BlockStateJsonValue;
      diagnostics: ParserDiagnostic[];
    };

export type ParsedBlockStateMultipart = {
  when: BlockStateMultipartCondition | null;
  apply: BlockStateModelDefinition[];
  raw: BlockStateJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedBlockStateDefinition = {
  id: string;
  namespace: string;
  path: string;
  filePath: string | null;
  variants: ParsedBlockStateVariant[];
  multipart: ParsedBlockStateMultipart[];
  propertyNames: string[];
  propertyValues: Record<string, string[]>;
  modelIds: string[];
  raw: BlockStateJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type BlockStatesParseResult = {
  blockStates: ParsedBlockStateDefinition[];
  blockStateById: Record<string, ParsedBlockStateDefinition>;
  variantCount: number;
  multipartCount: number;
  propertyValueCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

const KNOWN_BLOCKSTATE_KEYS = new Set(["variants", "multipart"]);
const KNOWN_MODEL_KEYS = new Set(["model", "x", "y", "uvlock", "weight"]);
const KNOWN_MULTIPART_KEYS = new Set(["when", "apply"]);

function diagnostic(input: {
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}): ParserDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: "warning",
    details: input.details,
  };
}

function isObject(value: unknown): value is BlockStateJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function blockStateIdFromFile(namespace: string, relativePath: string): string {
  return `${namespace}:${relativePath.replace(/\.json$/, "").split(path.sep).join("/")}`;
}

function validateUnknownKeys(input: {
  raw: BlockStateJsonObject;
  knownKeys: Set<string>;
  diagnostics: ParserDiagnostic[];
  code: string;
  id: string;
  context: string;
}): void {
  for (const key of Object.keys(input.raw)) {
    if (!input.knownKeys.has(key)) {
      input.diagnostics.push(
        diagnostic({
          code: input.code,
          message: `${input.context} '${input.id}' has unhandled key '${key}'.`,
          details: { id: input.id, key },
        }),
      );
    }
  }
}

function toNumber(value: BlockStateJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseModelDefinition(raw: BlockStateJsonValue, blockStateId: string): BlockStateModelDefinition {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic({
        code: "block_states.model.invalid",
        message: `Blockstate '${blockStateId}' has a model entry that is not an object.`,
        details: { blockStateId },
      }),
    );
    return { model: null, x: null, y: null, uvlock: null, weight: null, raw: {}, diagnostics };
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_MODEL_KEYS,
    diagnostics,
    code: "block_states.model.unhandled_key",
    id: blockStateId,
    context: "Model entry in blockstate",
  });

  if (raw.model !== undefined && typeof raw.model !== "string") {
    diagnostics.push(
      diagnostic({
        code: "block_states.model.invalid_model",
        message: `Blockstate '${blockStateId}' has a model id that is not a string.`,
        details: { blockStateId },
      }),
    );
  }

  return {
    model: typeof raw.model === "string" ? normalizeIdentifier(raw.model) : null,
    x: toNumber(raw.x),
    y: toNumber(raw.y),
    uvlock: typeof raw.uvlock === "boolean" ? raw.uvlock : null,
    weight: toNumber(raw.weight),
    raw,
    diagnostics,
  };
}

function parseModelList(raw: BlockStateJsonValue, blockStateId: string): BlockStateModelDefinition[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => parseModelDefinition(entry, blockStateId));
  }
  return [parseModelDefinition(raw, blockStateId)];
}

function parseVariantProperties(stateKey: string): Record<string, string> {
  if (stateKey.trim() === "") {
    return {};
  }

  return Object.fromEntries(
    stateKey.split(",").flatMap((part) => {
      const [key, ...valueParts] = part.split("=");
      const value = valueParts.join("=");
      return key && value ? [[key.trim(), value.trim()]] : [];
    }),
  );
}

function parseVariants(raw: BlockStateJsonValue, blockStateId: string): ParsedBlockStateVariant[] {
  if (!isObject(raw)) {
    return [];
  }

  return Object.entries(raw)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stateKey, value]) => {
      const models = parseModelList(value, blockStateId);
      return {
        stateKey,
        properties: parseVariantProperties(stateKey),
        models,
        raw: value,
        diagnostics: models.flatMap((model) => model.diagnostics),
      };
    });
}

function parseCondition(raw: BlockStateJsonValue, blockStateId: string): BlockStateMultipartCondition {
  if (!isObject(raw)) {
    return {
      kind: "unknown",
      raw,
      diagnostics: [
        diagnostic({
          code: "block_states.multipart.condition_invalid",
          message: `Blockstate '${blockStateId}' has a multipart condition that is not an object.`,
          details: { blockStateId },
        }),
      ],
    };
  }

  if (Array.isArray(raw.OR)) {
    return {
      kind: "or",
      terms: raw.OR.map((entry) => parseCondition(entry, blockStateId)),
      raw,
    };
  }
  if (Array.isArray(raw.AND)) {
    return {
      kind: "and",
      terms: raw.AND.map((entry) => parseCondition(entry, blockStateId)),
      raw,
    };
  }

  return {
    kind: "properties",
    properties: Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) => {
        if (typeof value !== "string") {
          return [];
        }
        return [[key, value.split("|").map((entry) => entry.trim()).filter(Boolean)]];
      }),
    ),
    raw,
  };
}

function conditionDiagnostics(condition: BlockStateMultipartCondition | null): ParserDiagnostic[] {
  if (!condition) {
    return [];
  }
  if (condition.kind === "unknown") {
    return condition.diagnostics;
  }
  if (condition.kind === "and" || condition.kind === "or") {
    return condition.terms.flatMap(conditionDiagnostics);
  }
  return [];
}

function conditionPropertyValues(condition: BlockStateMultipartCondition | null): Record<string, string[]> {
  if (!condition) {
    return {};
  }
  if (condition.kind === "properties") {
    return condition.properties;
  }
  if (condition.kind === "and" || condition.kind === "or") {
    const values: Record<string, string[]> = {};
    for (const term of condition.terms) {
      for (const [key, termValues] of Object.entries(conditionPropertyValues(term))) {
        values[key] = Array.from(new Set([...(values[key] ?? []), ...termValues])).sort();
      }
    }
    return values;
  }
  return {};
}

function parseMultipart(raw: BlockStateJsonValue, blockStateId: string): ParsedBlockStateMultipart[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((entry) => {
    const diagnostics: ParserDiagnostic[] = [];
    if (!isObject(entry)) {
      diagnostics.push(
        diagnostic({
          code: "block_states.multipart.invalid",
          message: `Blockstate '${blockStateId}' has a multipart entry that is not an object.`,
          details: { blockStateId },
        }),
      );
      return { when: null, apply: [], raw: {}, diagnostics };
    }

    validateUnknownKeys({
      raw: entry,
      knownKeys: KNOWN_MULTIPART_KEYS,
      diagnostics,
      code: "block_states.multipart.unhandled_key",
      id: blockStateId,
      context: "Multipart entry in blockstate",
    });

    const when = entry.when === undefined ? null : parseCondition(entry.when, blockStateId);
    const apply = entry.apply === undefined ? [] : parseModelList(entry.apply, blockStateId);
    diagnostics.push(...conditionDiagnostics(when), ...apply.flatMap((model) => model.diagnostics));
    return { when, apply, raw: entry, diagnostics };
  });
}

function addPropertyValue(values: Record<string, Set<string>>, key: string, value: string): void {
  values[key] = values[key] ?? new Set<string>();
  values[key].add(value);
}

function collectPropertyValues(input: {
  variants: ParsedBlockStateVariant[];
  multipart: ParsedBlockStateMultipart[];
}): Record<string, string[]> {
  const values: Record<string, Set<string>> = {};
  for (const variant of input.variants) {
    for (const [key, value] of Object.entries(variant.properties)) {
      addPropertyValue(values, key, value);
    }
  }
  for (const multipart of input.multipart) {
    for (const [key, propertyValues] of Object.entries(conditionPropertyValues(multipart.when))) {
      for (const value of propertyValues) {
        addPropertyValue(values, key, value);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Array.from(value).sort()]),
  );
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function parseBlockStateJson(input: {
  id: string;
  raw: BlockStateJsonValue;
  filePath?: string | null;
}): ParsedBlockStateDefinition {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(input.raw)) {
    diagnostics.push(
      diagnostic({
        code: "block_states.invalid_root",
        message: `Blockstate '${input.id}' root is not an object.`,
        details: { blockStateId: input.id },
      }),
    );
    const [namespace = "minecraft", pathId = input.id] = input.id.split(":");
    return {
      id: input.id,
      namespace,
      path: pathId,
      filePath: input.filePath ?? null,
      variants: [],
      multipart: [],
      propertyNames: [],
      propertyValues: {},
      modelIds: [],
      raw: {},
      diagnostics,
    };
  }

  validateUnknownKeys({
    raw: input.raw,
    knownKeys: KNOWN_BLOCKSTATE_KEYS,
    diagnostics,
    code: "block_states.root.unhandled_key",
    id: input.id,
    context: "Blockstate",
  });

  const [namespace = "minecraft", pathId = input.id] = input.id.split(":");
  const variants = parseVariants(input.raw.variants, input.id);
  const multipart = parseMultipart(input.raw.multipart, input.id);
  const propertyValues = collectPropertyValues({ variants, multipart });
  diagnostics.push(
    ...variants.flatMap((variant) => variant.diagnostics),
    ...multipart.flatMap((entry) => entry.diagnostics),
  );

  return {
    id: input.id,
    namespace,
    path: pathId,
    filePath: input.filePath ?? null,
    variants,
    multipart,
    propertyNames: Object.keys(propertyValues),
    propertyValues,
    modelIds: uniqueSorted([
      ...variants.flatMap((variant) => variant.models.flatMap((model) => model.model ? [model.model] : [])),
      ...multipart.flatMap((entry) => entry.apply.flatMap((model) => model.model ? [model.model] : [])),
    ]),
    raw: input.raw,
    diagnostics,
  };
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectJsonFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await readdir(directory);
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

export async function loadBlockStatesFromDirectory(input: {
  blockStatesDirectory: string;
  namespace?: string;
}): Promise<BlockStatesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const files = (await collectJsonFiles(input.blockStatesDirectory)).sort();
  const blockStates = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(input.blockStatesDirectory, filePath);
      const id = blockStateIdFromFile(namespace, relativePath);
      return parseBlockStateJson({
        id,
        raw: JSON.parse(await readFile(filePath, "utf8")) as BlockStateJsonValue,
        filePath,
      });
    }),
  );

  const propertyValueCounts: Record<string, number> = {};
  for (const blockState of blockStates) {
    for (const [propertyName, values] of Object.entries(blockState.propertyValues)) {
      propertyValueCounts[propertyName] = Math.max(propertyValueCounts[propertyName] ?? 0, values.length);
    }
  }

  return {
    blockStates,
    blockStateById: Object.fromEntries(blockStates.map((blockState) => [blockState.id, blockState])),
    variantCount: blockStates.reduce((total, blockState) => total + blockState.variants.length, 0),
    multipartCount: blockStates.reduce((total, blockState) => total + blockState.multipart.length, 0),
    propertyValueCounts,
    diagnostics: blockStates.flatMap((blockState) => blockState.diagnostics),
  };
}

export async function loadBlockStatesFromAssetsRoot(input: {
  assetsRoot: string;
  namespace?: string;
}): Promise<BlockStatesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const candidates = [
    path.join(input.assetsRoot, "assets", namespace, "blockstates"),
    path.join(input.assetsRoot, namespace, "blockstates"),
    path.join(input.assetsRoot, "blockstates"),
  ];

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      return loadBlockStatesFromDirectory({
        blockStatesDirectory: candidate,
        namespace,
      });
    }
  }

  return {
    blockStates: [],
    blockStateById: {},
    variantCount: 0,
    multipartCount: 0,
    propertyValueCounts: {},
    diagnostics: [
      diagnostic({
        code: "block_states.directory_missing",
        message: `Could not find blockstates directory under '${input.assetsRoot}'.`,
        details: { assetsRoot: input.assetsRoot, namespace },
      }),
    ],
  };
}

export function applyBlockStateDataToBlocks(
  blocks: BlocksParseResult,
  blockStates: BlockStatesParseResult,
): BlocksParseResult {
  const blocksWithStates = blocks.blocks.map((block) => ({
    ...block,
    blockStateDefinition: block.id ? blockStates.blockStateById[block.id] ?? null : null,
  }));

  return {
    ...blocks,
    blocks: blocksWithStates,
    blockByFieldName: Object.fromEntries(blocksWithStates.map((block) => [block.fieldName, block])),
    blockById: Object.fromEntries(blocksWithStates.flatMap((block) => block.id ? [[block.id, block]] : [])),
    diagnostics: [...blocks.diagnostics, ...blockStates.diagnostics],
  };
}
