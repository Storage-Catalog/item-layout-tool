import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";

type TagJsonPrimitive = string | number | boolean | null;
type TagJsonValue = TagJsonPrimitive | TagJsonValue[] | { [key: string]: TagJsonValue };
type TagJsonObject = { [key: string]: TagJsonValue };

export type ParsedTagValue = {
  id: string;
  kind: "block" | "tag";
  required: boolean;
  raw: TagJsonValue;
};

export type ParsedBlockTag = {
  id: string;
  namespace: string;
  path: string;
  filePath: string | null;
  replace: boolean;
  values: ParsedTagValue[];
  directBlockIds: string[];
  referencedTagIds: string[];
  expandedBlockIds: string[];
  unresolvedTagIds: string[];
  raw: TagJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type BlockTagsParseResult = {
  tags: ParsedBlockTag[];
  tagById: Record<string, ParsedBlockTag>;
  blockTagsByBlockId: Record<string, string[]>;
  diagnostics: ParserDiagnostic[];
};

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

function isObject(value: unknown): value is TagJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(id: string, defaultNamespace = "minecraft"): string {
  return id.includes(":") ? id : `${defaultNamespace}:${id}`;
}

function blockTagIdFromFile(namespace: string, relativePath: string): string {
  return `${namespace}:${relativePath.replace(/\.json$/, "").split(path.sep).join("/")}`;
}

function parseTagValue(raw: TagJsonValue, tagId: string): { value: ParsedTagValue | null; diagnostics: ParserDiagnostic[] } {
  const diagnostics: ParserDiagnostic[] = [];
  let id: string | null = null;
  let required = true;

  if (typeof raw === "string") {
    id = raw;
  } else if (isObject(raw)) {
    if (typeof raw.id === "string") {
      id = raw.id;
    }
    if (typeof raw.required === "boolean") {
      required = raw.required;
    }
  }

  if (!id) {
    diagnostics.push(
      diagnostic({
        code: "block_tags.invalid_value",
        message: `Block tag '${tagId}' contains a value that is not a string or object with an id.`,
        details: { tagId },
      }),
    );
    return { value: null, diagnostics };
  }

  const kind = id.startsWith("#") ? "tag" : "block";
  return {
    value: {
      id: normalizeIdentifier(kind === "tag" ? id.slice(1) : id),
      kind,
      required,
      raw,
    },
    diagnostics,
  };
}

function parseBlockTagJson(input: {
  id: string;
  raw: TagJsonValue;
  filePath?: string | null;
}): ParsedBlockTag {
  const diagnostics: ParserDiagnostic[] = [];
  const [namespace = "minecraft", ...pathParts] = input.id.split(":");
  const raw = isObject(input.raw) ? input.raw : {};
  if (!isObject(input.raw)) {
    diagnostics.push(
      diagnostic({
        code: "block_tags.invalid_root",
        message: `Block tag '${input.id}' root is not an object.`,
        details: { tagId: input.id },
      }),
    );
  }

  const valuesRaw = Array.isArray(raw.values) ? raw.values : [];
  if (!Array.isArray(raw.values)) {
    diagnostics.push(
      diagnostic({
        code: "block_tags.missing_values",
        message: `Block tag '${input.id}' does not contain a values array.`,
        details: { tagId: input.id },
      }),
    );
  }

  const values: ParsedTagValue[] = [];
  for (const rawValue of valuesRaw) {
    const parsed = parseTagValue(rawValue, input.id);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value) {
      values.push(parsed.value);
    }
  }

  return {
    id: input.id,
    namespace,
    path: pathParts.join(":"),
    filePath: input.filePath ?? null,
    replace: typeof raw.replace === "boolean" ? raw.replace : false,
    values,
    directBlockIds: values.filter((value) => value.kind === "block").map((value) => value.id).sort(),
    referencedTagIds: values.filter((value) => value.kind === "tag").map((value) => value.id).sort(),
    expandedBlockIds: [],
    unresolvedTagIds: [],
    raw,
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

function expandTag(
  tag: ParsedBlockTag,
  tagById: Record<string, ParsedBlockTag>,
  stack: string[] = [],
): { blockIds: string[]; unresolvedTagIds: string[]; diagnostics: ParserDiagnostic[] } {
  const blockIds = new Set(tag.directBlockIds);
  const unresolvedTagIds = new Set<string>();
  const diagnostics: ParserDiagnostic[] = [];

  for (const referencedTagId of tag.referencedTagIds) {
    if (stack.includes(referencedTagId)) {
      diagnostics.push(
        diagnostic({
          code: "block_tags.cyclic_reference",
          message: `Block tag '${tag.id}' has a cyclic tag reference to '${referencedTagId}'.`,
          details: { tagId: tag.id, referencedTagId },
        }),
      );
      continue;
    }

    const referencedTag = tagById[referencedTagId];
    if (!referencedTag) {
      unresolvedTagIds.add(referencedTagId);
      continue;
    }

    const expanded = expandTag(referencedTag, tagById, [...stack, tag.id]);
    diagnostics.push(...expanded.diagnostics);
    for (const blockId of expanded.blockIds) {
      blockIds.add(blockId);
    }
    for (const unresolvedTagId of expanded.unresolvedTagIds) {
      unresolvedTagIds.add(unresolvedTagId);
    }
  }

  return {
    blockIds: Array.from(blockIds).sort(),
    unresolvedTagIds: Array.from(unresolvedTagIds).sort(),
    diagnostics,
  };
}

export async function loadBlockTagsFromDataRoot(input: {
  dataRoot: string;
  namespace?: string;
}): Promise<BlockTagsParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const candidates = [
    path.join(input.dataRoot, "data", namespace, "tags", "block"),
    path.join(input.dataRoot, namespace, "tags", "block"),
    path.join(input.dataRoot, "tags", "block"),
  ];

  const tagDirectory = await (async () => {
    for (const candidate of candidates) {
      if (await directoryExists(candidate)) {
        return candidate;
      }
    }
    return null;
  })();

  if (!tagDirectory) {
    return {
      tags: [],
      tagById: {},
      blockTagsByBlockId: {},
      diagnostics: [
        diagnostic({
          code: "block_tags.directory_missing",
          message: `Could not find block tag directory under '${input.dataRoot}'.`,
          details: { dataRoot: input.dataRoot, namespace },
        }),
      ],
    };
  }

  const files = (await collectJsonFiles(tagDirectory)).sort();
  const tags = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(tagDirectory, filePath);
      return parseBlockTagJson({
        id: blockTagIdFromFile(namespace, relativePath),
        raw: JSON.parse(await readFile(filePath, "utf8")) as TagJsonValue,
        filePath,
      });
    }),
  );
  const tagById = Object.fromEntries(tags.map((tag) => [tag.id, tag]));
  const diagnostics = tags.flatMap((tag) => tag.diagnostics);

  for (const tag of tags) {
    const expanded = expandTag(tag, tagById);
    tag.expandedBlockIds = expanded.blockIds;
    tag.unresolvedTagIds = expanded.unresolvedTagIds;
    diagnostics.push(...expanded.diagnostics);
    for (const unresolvedTagId of expanded.unresolvedTagIds) {
      diagnostics.push(
        diagnostic({
          code: "block_tags.unresolved_reference",
          message: `Block tag '${tag.id}' references missing tag '${unresolvedTagId}'.`,
          details: { tagId: tag.id, unresolvedTagId },
        }),
      );
    }
  }

  const blockTagsByBlockId: Record<string, string[]> = {};
  for (const tag of tags) {
    for (const blockId of tag.expandedBlockIds) {
      blockTagsByBlockId[blockId] = blockTagsByBlockId[blockId] ?? [];
      blockTagsByBlockId[blockId].push(tag.id);
    }
  }
  for (const tagIds of Object.values(blockTagsByBlockId)) {
    tagIds.sort();
  }

  return {
    tags,
    tagById,
    blockTagsByBlockId,
    diagnostics,
  };
}
