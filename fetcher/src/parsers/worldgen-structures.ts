import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { ParserDiagnostic } from "../java/parser-utils";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type ParsedWorldgenBlockSource = {
  sourceType: "structure_template" | "structure_processor";
  id: string;
  filePath: string;
};

export type WorldgenStructuresParseResult = {
  blockIds: string[];
  sourcesByBlockId: Record<string, ParsedWorldgenBlockSource[]>;
  structureTemplateCount: number;
  processorListCount: number;
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(id: string, defaultNamespace = "minecraft"): string {
  return id.includes(":") ? id : `${defaultNamespace}:${id}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readdir(filePath);
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

async function collectFiles(directory: string, extension: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(entryPath, extension);
      }
      return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}

function dataIdFromFile(namespace: string, root: string, filePath: string, extension: string): string {
  const relativePath = path.relative(root, filePath).replace(new RegExp(`${extension.replace(".", "\\.")}$`), "");
  return `${namespace}:${relativePath.split(path.sep).join("/")}`;
}

function inflateNbt(bytes: Buffer): Buffer {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes);
  }
  return bytes;
}

class NbtReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  readRoot(): unknown {
    const type = this.readU8();
    if (type === 0) {
      return null;
    }
    this.readString();
    return this.readPayload(type);
  }

  private readU8(): number {
    const value = this.bytes.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private readI16(): number {
    const value = this.bytes.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  private readI32(): number {
    const value = this.bytes.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private readString(): string {
    const length = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    const value = this.bytes.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readPayload(type: number): unknown {
    switch (type) {
      case 1:
        return this.readU8();
      case 2:
        return this.readI16();
      case 3:
        return this.readI32();
      case 4:
        this.offset += 8;
        return null;
      case 5:
        this.offset += 4;
        return null;
      case 6:
        this.offset += 8;
        return null;
      case 7: {
        const length = this.readI32();
        this.offset += length;
        return null;
      }
      case 8:
        return this.readString();
      case 9: {
        const itemType = this.readU8();
        const length = this.readI32();
        const values: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          values.push(this.readPayload(itemType));
        }
        return values;
      }
      case 10: {
        const value: Record<string, unknown> = {};
        while (true) {
          const childType = this.readU8();
          if (childType === 0) {
            return value;
          }
          const name = this.readString();
          value[name] = this.readPayload(childType);
        }
      }
      case 11: {
        const length = this.readI32();
        this.offset += length * 4;
        return null;
      }
      case 12: {
        const length = this.readI32();
        this.offset += length * 8;
        return null;
      }
      default:
        throw new Error(`Unsupported NBT tag type ${type} at byte ${this.offset}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPaletteNames(value: unknown): string[] {
  const ids: string[] = [];
  const collectPalette = (palette: unknown) => {
    if (!Array.isArray(palette)) {
      return;
    }
    for (const entry of palette) {
      if (isRecord(entry) && typeof entry.Name === "string") {
        ids.push(normalizeIdentifier(entry.Name));
      }
    }
  };
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) {
      for (const child of entry) {
        visit(child);
      }
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    collectPalette(entry.palette);
    if (Array.isArray(entry.palettes)) {
      for (const palette of entry.palettes) {
        collectPalette(palette);
      }
    }
    for (const child of Object.values(entry)) {
      visit(child);
    }
  };
  visit(value);
  return Array.from(new Set(ids)).sort();
}

function collectMinecraftIdsFromNbt(bytes: Buffer, knownBlockIds: Set<string>): string[] {
  const root = new NbtReader(inflateNbt(bytes)).readRoot();
  return collectPaletteNames(root)
    .filter((id) => knownBlockIds.has(id))
    .sort();
}

function collectOutputStateBlockIds(value: JsonValue, knownBlockIds: Set<string>): string[] {
  const ids: string[] = [];
  const visit = (entry: JsonValue, parentKey: string | null) => {
    if (typeof entry === "string") {
      if ((parentKey === "Name" || parentKey === "block") && knownBlockIds.has(normalizeIdentifier(entry))) {
        ids.push(normalizeIdentifier(entry));
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) {
        visit(child, parentKey);
      }
      return;
    }
    if (!isObject(entry)) {
      return;
    }
    const outputState = entry.output_state;
    if (isObject(outputState) && typeof outputState.Name === "string") {
      const id = normalizeIdentifier(outputState.Name);
      if (knownBlockIds.has(id)) {
        ids.push(id);
      }
    }
    for (const [key, child] of Object.entries(entry)) {
      visit(child, key);
    }
  };
  visit(value, null);
  return Array.from(new Set(ids)).sort();
}

function addSource(
  sourcesByBlockId: Record<string, ParsedWorldgenBlockSource[]>,
  blockId: string,
  source: ParsedWorldgenBlockSource,
): void {
  sourcesByBlockId[blockId] = sourcesByBlockId[blockId] ?? [];
  if (!sourcesByBlockId[blockId].some((entry) => entry.sourceType === source.sourceType && entry.id === source.id)) {
    sourcesByBlockId[blockId].push(source);
  }
}

export async function loadWorldgenStructuresFromDataRoot(input: {
  dataRoot: string;
  knownBlockIds: string[];
}): Promise<WorldgenStructuresParseResult> {
  const diagnostics: ParserDiagnostic[] = [];
  const knownBlockIds = new Set(input.knownBlockIds.map((id) => normalizeIdentifier(id)));
  const minecraftRoot = path.join(input.dataRoot, "data", "minecraft");
  const structureRoot = path.join(minecraftRoot, "structure");
  const processorRoot = path.join(minecraftRoot, "worldgen", "processor_list");
  const sourcesByBlockId: Record<string, ParsedWorldgenBlockSource[]> = {};

  const structureFiles = await collectFiles(structureRoot, ".nbt");
  await Promise.all(
    structureFiles.map(async (filePath) => {
      try {
        const id = dataIdFromFile("minecraft", structureRoot, filePath, ".nbt");
        const blockIds = collectMinecraftIdsFromNbt(await readFile(filePath), knownBlockIds);
        for (const blockId of blockIds) {
          addSource(sourcesByBlockId, blockId, {
            sourceType: "structure_template",
            id,
            filePath,
          });
        }
      } catch (error) {
        diagnostics.push(
          diagnostic({
            code: "worldgen_structures.structure_template_failed",
            message: `Could not scan structure template '${filePath}'.`,
            details: { filePath, error: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
    }),
  );

  const processorFiles = await collectFiles(processorRoot, ".json");
  await Promise.all(
    processorFiles.map(async (filePath) => {
      try {
        const id = dataIdFromFile("minecraft", processorRoot, filePath, ".json");
        const raw = JSON.parse(await readFile(filePath, "utf8")) as JsonValue;
        for (const blockId of collectOutputStateBlockIds(raw, knownBlockIds)) {
          addSource(sourcesByBlockId, blockId, {
            sourceType: "structure_processor",
            id,
            filePath,
          });
        }
      } catch (error) {
        diagnostics.push(
          diagnostic({
            code: "worldgen_structures.processor_list_failed",
            message: `Could not scan structure processor '${filePath}'.`,
            details: { filePath, error: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
    }),
  );

  for (const sources of Object.values(sourcesByBlockId)) {
    sources.sort((left, right) => `${left.sourceType}:${left.id}`.localeCompare(`${right.sourceType}:${right.id}`));
  }

  return {
    blockIds: Object.keys(sourcesByBlockId).sort(),
    sourcesByBlockId,
    structureTemplateCount: structureFiles.length,
    processorListCount: processorFiles.length,
    diagnostics,
  };
}
