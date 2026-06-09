import type { ParserDiagnostic } from "../java/parser-utils";

export type ParsedFlammabilityEntry = {
  blockId: string;
  igniteOdds: number | null;
  burnOdds: number | null;
  source: string;
  diagnostics: ParserDiagnostic[];
};

export type FlammabilityParseResult = {
  entries: ParsedFlammabilityEntry[];
  entryByBlockId: Record<string, ParsedFlammabilityEntry>;
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

export function parseFireBlockSource(source: string): FlammabilityParseResult {
  const entries: ParsedFlammabilityEntry[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const flammableCallRe = /\b(?:this\.)?setFlammable\s*\(\s*Blocks\.([A-Z0-9_]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;

  for (const match of source.matchAll(flammableCallRe)) {
    entries.push({
      blockId: toMinecraftIdFromConstant(match[1]),
      igniteOdds: Number(match[2]),
      burnOdds: Number(match[3]),
      source: match[0],
      diagnostics: [],
    });
  }

  if (entries.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "flammability.none_found",
        message: "No FireBlock setFlammable calls were parsed.",
      }),
    );
  }

  return {
    entries,
    entryByBlockId: Object.fromEntries(entries.map((entry) => [entry.blockId, entry])),
    diagnostics,
  };
}
