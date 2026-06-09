import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";

export type ParsedBlockBehaviorMethod = {
  name: string;
  returnType: string | null;
  parameters: string;
  source: string;
  returnExpressions: string[];
  conditionExpressions: string[];
  referencedBlockTags: string[];
  referencedBlocks: string[];
};

export type ParsedBlockBehaviorClass = {
  className: string;
  superClassName: string | null;
  filePath: string | null;
  methods: Record<string, ParsedBlockBehaviorMethod>;
  diagnostics: ParserDiagnostic[];
};

export type ResolvedBlockBehavior = {
  className: string;
  classChain: string[];
  methods: Record<string, ParsedBlockBehaviorMethod & { sourceClassName: string; inherited: boolean }>;
  methodImplementations: Record<string, Array<ParsedBlockBehaviorMethod & { sourceClassName: string; inherited: boolean }>>;
};

export type BlockBehaviorsParseResult = {
  classes: ParsedBlockBehaviorClass[];
  classByName: Record<string, ParsedBlockBehaviorClass>;
  resolvedByClassName: Record<string, ResolvedBlockBehavior>;
  diagnostics: ParserDiagnostic[];
};

const BEHAVIOR_METHOD_NAMES = [
  "animateTick",
  "attack",
  "canBeReplaced",
  "canConnectRedstone",
  "canSurvive",
  "entityInside",
  "fallOn",
  "getAnalogOutputSignal",
  "getDirectSignal",
  "getSignal",
  "getTicker",
  "hasAnalogOutputSignal",
  "isPathfindable",
  "isSignalSource",
  "mayPlaceOn",
  "neighborChanged",
  "onPlace",
  "propagatesSkylightDown",
  "randomTick",
  "skipRendering",
  "stepOn",
  "tick",
  "triggerEvent",
  "updateEntityAfterFallOn",
  "updateShape",
  "useItemOn",
  "useShapeForLightOcclusion",
  "useWithoutItem",
] as const;

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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function toMinecraftIdFromConstant(value: string): string {
  return `minecraft:${value.toLowerCase()}`;
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function collectReturnExpressions(source: string): string[] {
  return uniqueSorted(
    Array.from(source.matchAll(/\breturn\s+([^;]+);/g)).map((match) => match[1].trim()),
  );
}

function collectConditionExpressions(source: string): string[] {
  return uniqueSorted(
    Array.from(source.matchAll(/\b(?:if|while)\s*\(([^;{}]+)\)/g))
      .map((match) => match[1].trim().replace(/\s+/g, " "))
      .filter((expression) => expression.length > 0),
  );
}

function collectReferencedBlockTags(source: string): string[] {
  return uniqueSorted(
    Array.from(source.matchAll(/\bBlockTags\.([A-Z0-9_]+)\b/g)).map((match) =>
      toMinecraftIdFromConstant(match[1]),
    ),
  );
}

function collectReferencedBlocks(source: string): string[] {
  return uniqueSorted(
    Array.from(source.matchAll(/\bBlocks\.([A-Z0-9_]+)\b/g)).map((match) =>
      toMinecraftIdFromConstant(match[1]),
    ),
  );
}

function parseClassSource(source: string, filePath: string | null): ParsedBlockBehaviorClass | null {
  const classMatch = source.match(/\b(?:public\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+extends\s+([A-Za-z_$][A-Za-z0-9_$]*))?/);
  if (!classMatch) {
    return null;
  }

  const methods: Record<string, ParsedBlockBehaviorMethod> = {};
  for (const methodName of BEHAVIOR_METHOD_NAMES) {
    const methodRe = new RegExp(
      `(?:public|protected|private)\\s+(?:static\\s+)?(?:<[^>]+>\\s+)?(?:@[A-Za-z_$][A-Za-z0-9_$]*(?:\\([^)]*\\))?\\s+)*([A-Za-z_$@][A-Za-z0-9_$<>?,\\s\\[\\]@.]*)\\s+${methodName}\\s*\\(([^)]*)\\)\\s*\\{`,
      "g",
    );
    for (const methodMatch of source.matchAll(methodRe)) {
      const openBraceIndex = (methodMatch.index ?? 0) + methodMatch[0].length - 1;
      const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
      if (closeBraceIndex === -1) {
        continue;
      }
      const methodSource = source.slice(methodMatch.index ?? 0, closeBraceIndex + 1);
      methods[methodName] = {
        name: methodName,
        returnType: methodMatch[1].trim().replace(/\s+/g, " "),
        parameters: methodMatch[2].trim().replace(/\s+/g, " "),
        source: methodSource,
        returnExpressions: collectReturnExpressions(methodSource),
        conditionExpressions: collectConditionExpressions(methodSource),
        referencedBlockTags: collectReferencedBlockTags(methodSource),
        referencedBlocks: collectReferencedBlocks(methodSource),
      };
    }
  }

  return {
    className: classMatch[1],
    superClassName: classMatch[2] ?? null,
    filePath,
    methods,
    diagnostics: [],
  };
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

function resolveBehavior(
  className: string,
  classByName: Record<string, ParsedBlockBehaviorClass>,
  stack: string[] = [],
): ResolvedBlockBehavior | null {
  const parsed = classByName[className];
  if (!parsed || stack.includes(className)) {
    return null;
  }
  const inherited = parsed.superClassName
    ? resolveBehavior(parsed.superClassName, classByName, [...stack, className])
    : null;
  const methods = { ...(inherited?.methods ?? {}) };
  const methodImplementations = Object.fromEntries(
    Object.entries(inherited?.methodImplementations ?? {}).map(([methodName, entries]) => [
      methodName,
      entries.map((entry) => ({ ...entry, inherited: true })),
    ]),
  ) as Record<string, Array<ParsedBlockBehaviorMethod & { sourceClassName: string; inherited: boolean }>>;
  for (const [methodName, method] of Object.entries(parsed.methods)) {
    methods[methodName] = { ...method, sourceClassName: className, inherited: false };
    methodImplementations[methodName] = [
      { ...method, sourceClassName: className, inherited: false },
      ...(methodImplementations[methodName] ?? []),
    ];
  }
  for (const [methodName, method] of Object.entries(methods)) {
    if (method.sourceClassName !== className) {
      methods[methodName] = { ...method, inherited: true };
    }
  }
  return {
    className,
    classChain: [className, ...(inherited?.classChain ?? [])],
    methods,
    methodImplementations,
  };
}

export async function loadBlockBehaviorsFromDecompiledRoot(input: {
  decompiledRoot: string;
}): Promise<BlockBehaviorsParseResult> {
  const roots = [
    path.join(input.decompiledRoot, "net", "minecraft", "world", "level", "block"),
    path.join(input.decompiledRoot, "net", "minecraft", "world", "level", "block", "state"),
  ];
  const diagnostics: ParserDiagnostic[] = [];
  const files = (
    await Promise.all(roots.map(async (root) => (await directoryExists(root) ? collectJavaFiles(root) : [])))
  ).flat();

  const classes = (
    await Promise.all(
      files.map(async (filePath) => parseClassSource(await readFile(filePath, "utf8"), filePath)),
    )
  ).filter((entry): entry is ParsedBlockBehaviorClass => Boolean(entry));

  if (classes.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "block_behaviors.none_found",
        message: `No block behavior classes were parsed under '${input.decompiledRoot}'.`,
        details: { decompiledRoot: input.decompiledRoot },
      }),
    );
  }

  const classByName = Object.fromEntries(classes.map((entry) => [entry.className, entry]));
  const resolvedEntries = classes
    .map((entry) => resolveBehavior(entry.className, classByName))
    .filter((entry): entry is ResolvedBlockBehavior => Boolean(entry));

  return {
    classes,
    classByName,
    resolvedByClassName: Object.fromEntries(resolvedEntries.map((entry) => [entry.className, entry])),
    diagnostics: [...diagnostics, ...classes.flatMap((entry) => entry.diagnostics)],
  };
}
