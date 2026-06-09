import type { ParserDiagnostic } from "../java/parser-utils";

export type ParsedBlockEntityType = {
  fieldName: string;
  id: string | null;
  blockIds: string[];
  source: string;
  diagnostics: ParserDiagnostic[];
};

export type BlockEntitiesParseResult = {
  blockEntityTypes: ParsedBlockEntityType[];
  blockEntityTypeByFieldName: Record<string, ParsedBlockEntityType>;
  blockEntityTypesByBlockId: Record<string, ParsedBlockEntityType[]>;
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

function toMinecraftIdFromConstant(value: string): string {
  return `minecraft:${value.toLowerCase()}`;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function collectBlockIds(source: string): string[] {
  return uniqueSorted(
    Array.from(source.matchAll(/\bBlocks\.([A-Z0-9_]+)\b/g)).map((match) =>
      toMinecraftIdFromConstant(match[1]),
    ),
  );
}

export function parseBlockEntityTypesSource(source: string): BlockEntitiesParseResult {
  const blockEntityTypes: ParsedBlockEntityType[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const fieldRe = /public\s+static\s+final\s+BlockEntityType(?:<[^;=]+>)?\s+([A-Z0-9_]+)\s*=\s*/g;

  for (const match of source.matchAll(fieldRe)) {
    const fieldName = match[1];
    const start = match.index ?? 0;
    const end = source.indexOf(";", start);
    if (end === -1) {
      diagnostics.push(
        diagnostic({
          code: "block_entities.statement_unterminated",
          message: `Block entity field '${fieldName}' statement was not terminated.`,
          details: { fieldName },
        }),
      );
      continue;
    }
    const statement = source.slice(start, end + 1);
    const id = statement.match(/\bregister\s*\(\s*"([^"]+)"/)?.[1] ?? null;
    const blockIds = collectBlockIds(statement);
    const entryDiagnostics: ParserDiagnostic[] = [];
    if (!id) {
      entryDiagnostics.push(
        diagnostic({
          code: "block_entities.id_missing",
          message: `Block entity field '${fieldName}' does not expose a string id in its register call.`,
          details: { fieldName },
        }),
      );
    }
    if (blockIds.length === 0) {
      entryDiagnostics.push(
        diagnostic({
          code: "block_entities.blocks_missing",
          message: `Block entity field '${fieldName}' does not reference any Blocks constants.`,
          details: { fieldName },
        }),
      );
    }
    blockEntityTypes.push({
      fieldName,
      id: id ? `minecraft:${id}` : null,
      blockIds,
      source: statement,
      diagnostics: entryDiagnostics,
    });
    diagnostics.push(...entryDiagnostics);
  }

  if (blockEntityTypes.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "block_entities.none_found",
        message: "No BlockEntityType static fields were parsed.",
      }),
    );
  }

  const blockEntityTypesByBlockId: Record<string, ParsedBlockEntityType[]> = {};
  for (const entry of blockEntityTypes) {
    for (const blockId of entry.blockIds) {
      blockEntityTypesByBlockId[blockId] = blockEntityTypesByBlockId[blockId] ?? [];
      blockEntityTypesByBlockId[blockId].push(entry);
    }
  }

  return {
    blockEntityTypes,
    blockEntityTypeByFieldName: Object.fromEntries(blockEntityTypes.map((entry) => [entry.fieldName, entry])),
    blockEntityTypesByBlockId,
    diagnostics,
  };
}
