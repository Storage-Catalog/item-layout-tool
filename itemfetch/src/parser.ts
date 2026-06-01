import type {
  BlockLootBehavior,
  ParsedBlock,
  ParsedCreativeTab,
  ParsedFood,
  ParsedItem,
  VanillaBlockLootEntry,
} from "./types";
import { stripMinecraftNamespace } from "./utils";

type TopLevelCall = {
  name: string;
  args: string[];
};

type MethodCall = {
  name: string;
  args: string[];
};

type FieldInitializer = {
  name: string;
  initializer: string;
};

type PropertiesHelper = {
  params: string[];
  hasNoLootTable: boolean;
  overrideLootTableExpression: string | null;
};

type BuilderHelper = {
  params: string[];
  returnExpression: string;
};

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";

  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let depthAngle = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      current += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") depthParen += 1;
    if (char === ")") depthParen = Math.max(0, depthParen - 1);
    if (char === "[") depthBracket += 1;
    if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    if (char === "{") depthBrace += 1;
    if (char === "}") depthBrace = Math.max(0, depthBrace - 1);
    if (char === "<") depthAngle += 1;
    if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char === separator &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0 &&
      depthAngle === 0
    ) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

function findMatchingParen(input: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function trimOuterParens(input: string): string {
  let value = input.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const closing = findMatchingParen(value, 0);
    if (closing !== value.length - 1) {
      break;
    }
    value = value.slice(1, -1).trim();
  }
  return value;
}

function stripLeadingCast(input: string): string {
  let value = input.trim();
  while (true) {
    if (!value.startsWith("(")) {
      return value;
    }

    const closeIndex = findMatchingParen(value, 0);
    if (closeIndex === -1) {
      return value;
    }

    const castText = value.slice(1, closeIndex);
    if (!/^[\w.$<>\[\], ?]+$/.test(castText)) {
      return value;
    }

    const remaining = value.slice(closeIndex + 1).trimStart();
    if (remaining.length === 0) {
      return value;
    }

    value = remaining;
  }
}

function parseTopLevelCall(input: string): TopLevelCall | null {
  const expression = stripLeadingCast(trimOuterParens(input));

  let openParenIndex = -1;
  let depthBracket = 0;
  let depthBrace = 0;
  let depthAngle = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "[") depthBracket += 1;
    if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    if (char === "{") depthBrace += 1;
    if (char === "}") depthBrace = Math.max(0, depthBrace - 1);
    if (char === "<") depthAngle += 1;
    if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char === "(" &&
      depthBracket === 0 &&
      depthBrace === 0 &&
      depthAngle === 0
    ) {
      openParenIndex = i;
      break;
    }
  }

  if (openParenIndex === -1) {
    return null;
  }

  const closeParenIndex = findMatchingParen(expression, openParenIndex);
  if (closeParenIndex === -1) {
    return null;
  }

  const trailing = expression.slice(closeParenIndex + 1).trim();
  if (trailing.length > 0) {
    return null;
  }

  const name = expression.slice(0, openParenIndex).trim();
  const rawArgs = expression.slice(openParenIndex + 1, closeParenIndex).trim();
  return {
    name,
    args: rawArgs.length === 0 ? [] : splitTopLevel(rawArgs, ","),
  };
}

function getBaseExpression(input: string): string {
  const expression = stripLeadingCast(trimOuterParens(input));
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char !== "(") {
      continue;
    }

    const closeParenIndex = findMatchingParen(expression, i);
    if (closeParenIndex === -1) {
      return expression.trim();
    }

    return expression.slice(0, closeParenIndex + 1).trim();
  }

  return expression.trim();
}

function extractMethodCalls(input: string): MethodCall[] {
  const calls: MethodCall[] = [];

  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let depthAngle = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "(") depthParen += 1;
    if (char === ")") depthParen = Math.max(0, depthParen - 1);
    if (char === "[") depthBracket += 1;
    if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    if (char === "{") depthBrace += 1;
    if (char === "}") depthBrace = Math.max(0, depthBrace - 1);
    if (char === "<") depthAngle += 1;
    if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char !== "." ||
      depthParen !== 0 ||
      depthBracket !== 0 ||
      depthBrace !== 0 ||
      depthAngle !== 0
    ) {
      continue;
    }

    let cursor = i + 1;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(cursor));
    if (!nameMatch) {
      continue;
    }

    const name = nameMatch[0];
    cursor += name.length;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }
    if (input[cursor] !== "(") {
      continue;
    }

    const closeParen = findMatchingParen(input, cursor);
    if (closeParen === -1) {
      continue;
    }

    const rawArgs = input.slice(cursor + 1, closeParen).trim();
    const args = rawArgs.length === 0 ? [] : splitTopLevel(rawArgs, ",");
    calls.push({ name, args });
    i = closeParen;
  }

  return calls;
}

function findStatementEnd(source: string, fromIndex: number): number {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let depthAngle = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = fromIndex; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "(") depthParen += 1;
    if (char === ")") depthParen = Math.max(0, depthParen - 1);
    if (char === "[") depthBracket += 1;
    if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    if (char === "{") depthBrace += 1;
    if (char === "}") depthBrace = Math.max(0, depthBrace - 1);
    if (char === "<") depthAngle += 1;
    if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char === ";" &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0 &&
      depthAngle === 0
    ) {
      return i;
    }
  }

  return -1;
}

function extractStaticFieldInitializers(
  source: string,
  typeName: string,
): FieldInitializer[] {
  const fields: FieldInitializer[] = [];
  const pattern = new RegExp(
    `public\\s+static\\s+final\\s+${typeName}\\s+([A-Z0-9_]+)\\s*=`,
    "g",
  );

  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    const statementStart = pattern.lastIndex;
    const statementEnd = findStatementEnd(source, statementStart);
    if (statementEnd === -1) {
      throw new Error(`Unable to find end of field declaration for ${typeName} ${name}`);
    }
    const initializer = source.slice(statementStart, statementEnd).trim();
    fields.push({ name, initializer });
    pattern.lastIndex = statementEnd + 1;
  }

  return fields;
}

function parseJavaStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return null;
  }
}

function parseIntegerLiteral(value: string): number | null {
  const normalized = value.trim().replace(/_/g, "");
  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }
  return Number.parseInt(normalized, 10);
}

function parseFloatLiteral(value: string): number | null {
  const normalized = value.trim().replace(/_/g, "");
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdD]?$/.test(normalized)) {
    return null;
  }
  const asNumber = Number.parseFloat(normalized.replace(/[fFdD]$/, ""));
  return Number.isFinite(asNumber) ? asNumber : null;
}

function parseBlockFieldReference(value: string): string | null {
  const trimmed = stripLeadingCast(value).trim();
  const match = /^(?:Blocks\.)?([A-Z0-9_]+)$/.exec(trimmed);
  return match ? match[1] : null;
}

function toSnakeCaseFromConstant(name: string): string {
  return name.toLowerCase();
}

function firstStringArgument(args: string[]): string | null {
  for (const arg of args) {
    const parsed = parseJavaStringLiteral(arg);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function findMethodArgument(source: string, methodName: string): string | null {
  const needle = `.${methodName}(`;
  let cursor = source.indexOf(needle);
  while (cursor !== -1) {
    const openIndex = cursor + needle.length - 1;
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex !== -1) {
      return source.slice(openIndex + 1, closeIndex).trim();
    }
    cursor = source.indexOf(needle, cursor + 1);
  }
  return null;
}

function parseParameterNames(parameterList: string): string[] {
  if (parameterList.trim().length === 0) {
    return [];
  }

  return splitTopLevel(parameterList, ",")
    .map((parameter) => {
      const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*\])?\s*$/.exec(
        parameter.trim(),
      );
      return match ? match[1] : null;
    })
    .filter((value): value is string => value !== null);
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaping = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function parsePropertiesHelpers(blocksSource: string): Map<string, PropertiesHelper> {
  const result = new Map<string, PropertiesHelper>();
  const signaturePattern =
    /private\s+static\s+(?:[A-Za-z0-9_$.]+\.)?Properties\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;

  let match: RegExpExecArray | null = null;
  while ((match = signaturePattern.exec(blocksSource)) !== null) {
    const methodName = match[1];
    const params = parseParameterNames(match[2]);
    const openBraceIndex = signaturePattern.lastIndex - 1;
    const closeBraceIndex = findMatchingBrace(blocksSource, openBraceIndex);
    if (closeBraceIndex === -1) {
      continue;
    }

    const body = blocksSource.slice(openBraceIndex + 1, closeBraceIndex);
    const hasNoLootTable = body.includes(".noLootTable()");
    const overrideLootTableExpression = findMethodArgument(body, "overrideLootTable");

    result.set(methodName, {
      params,
      hasNoLootTable,
      overrideLootTableExpression: overrideLootTableExpression ?? null,
    });

    signaturePattern.lastIndex = closeBraceIndex + 1;
  }

  return result;
}

function parseBuilderHelpers(source: string): Map<string, BuilderHelper> {
  const result = new Map<string, BuilderHelper>();
  const signaturePattern =
    /private\s+static\s+(?:[A-Za-z0-9_$.]+\.)?Builder\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;

  let match: RegExpExecArray | null = null;
  while ((match = signaturePattern.exec(source)) !== null) {
    const methodName = match[1];
    const params = parseParameterNames(match[2]);
    const openBraceIndex = signaturePattern.lastIndex - 1;
    const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
    if (closeBraceIndex === -1) {
      continue;
    }

    const body = source.slice(openBraceIndex + 1, closeBraceIndex);
    const returnMatch = /return\s+([\s\S]*?);/.exec(body);
    if (returnMatch) {
      result.set(methodName, {
        params,
        returnExpression: returnMatch[1].trim(),
      });
    }

    signaturePattern.lastIndex = closeBraceIndex + 1;
  }

  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substituteParams(template: string, params: string[], args: string[]): string {
  let output = template;
  for (let i = 0; i < params.length; i += 1) {
    const name = params[i];
    const replacement = args[i]?.trim() ?? name;
    output = output.replace(
      new RegExp(`(?<![A-Za-z0-9_$.])${escapeRegex(name)}\\b`, "g"),
      replacement,
    );
  }
  return output;
}

function inferBlockLoot(
  propertiesExpression: string | null,
  helpers: Map<string, PropertiesHelper>,
): BlockLootBehavior {
  let noLootTable = false;
  let overrideLootTable: string | null = null;
  let helperMethod: string | null = null;

  if (propertiesExpression) {
    const calls = extractMethodCalls(propertiesExpression);
    for (const call of calls) {
      if (call.name === "noLootTable") {
        noLootTable = true;
      }
      if (call.name === "overrideLootTable" && call.args.length > 0) {
        overrideLootTable = call.args[0].trim();
      }
    }

    if (!noLootTable && overrideLootTable === null) {
      const baseExpression = getBaseExpression(propertiesExpression);
      const baseCall = parseTopLevelCall(baseExpression);
      const helperName = baseCall ? getUnqualifiedMethodName(baseCall.name) : null;
      if (baseCall && helperName && helpers.has(helperName)) {
        helperMethod = helperName;
        const helper = helpers.get(helperName)!;
        if (helper.hasNoLootTable) {
          noLootTable = true;
        }
        if (helper.overrideLootTableExpression) {
          overrideLootTable = substituteParams(
            helper.overrideLootTableExpression,
            helper.params,
            baseCall.args,
          );
        }
      }
    }
  }

  let copyFrom: string | null = null;
  if (propertiesExpression) {
    const copyMatch =
      /Properties\.of(?:Legacy|Full)?Copy\(\s*([^)]+?)\s*\)/.exec(propertiesExpression);
    if (copyMatch) {
      copyFrom = copyMatch[1].trim();
    }
  }

  let overrideLootSourceBlock: string | null = null;
  if (overrideLootTable) {
    const sourceMatch = /(?:Blocks\.)?([A-Z0-9_]+)\.getLootTable\(\)/.exec(
      overrideLootTable,
    );
    if (sourceMatch) {
      overrideLootSourceBlock = sourceMatch[1];
    }
  }

  let behavior: BlockLootBehavior["behavior"] = "default";
  if (noLootTable) {
    behavior = "no_loot_table";
  } else if (overrideLootTable) {
    behavior = "override_loot_table";
  }

  return {
    behavior,
    noLootTable,
    overrideLootTable,
    overrideLootSourceBlock,
    propertiesExpression,
    helperMethod,
    copyFrom,
  };
}

export function parseBlocks(blocksSource: string): ParsedBlock[] {
  const helpers = parsePropertiesHelpers(blocksSource);
  const fields = extractStaticFieldInitializers(blocksSource, "Block");

  const blocks: ParsedBlock[] = [];
  for (const field of fields) {
    const outerCall = parseTopLevelCall(field.initializer);
    let id = toSnakeCaseFromConstant(field.name);
    let propertiesExpression: string | null = null;

    if (outerCall) {
      const literalId = firstStringArgument(outerCall.args);
      if (literalId !== null) {
        id = stripMinecraftNamespace(literalId);
      }

      if (outerCall.name.endsWith("register")) {
        if (outerCall.args.length >= 2) {
          propertiesExpression = outerCall.args[outerCall.args.length - 1].trim();
        }
      }
    }

    const loot = inferBlockLoot(propertiesExpression, helpers);
    blocks.push({
      fieldName: field.name,
      id,
      loot,
    });
  }

  return blocks;
}

function expandBuilderCallsFromHelpers(
  initializer: string,
  helpers: Map<string, BuilderHelper>,
): MethodCall[] {
  const calls = extractMethodCalls(initializer);
  const baseExpression = getBaseExpression(initializer);
  const baseCall = parseTopLevelCall(baseExpression);
  const helperName = baseCall ? getUnqualifiedMethodName(baseCall.name) : null;

  if (!baseCall || !helperName || !helpers.has(helperName)) {
    return calls;
  }

  const helper = helpers.get(helperName)!;
  const substituted = substituteParams(helper.returnExpression, helper.params, baseCall.args);
  const helperCalls = extractMethodCalls(substituted);
  const tailCalls =
    calls.length > 0 && calls[0].name === helperName ? calls.slice(1) : calls;
  return [...helperCalls, ...tailCalls];
}

export function parseFoods(foodsSource: string): ParsedFood[] {
  const fields = extractStaticFieldInitializers(foodsSource, "FoodProperties");
  const builderHelpers = parseBuilderHelpers(foodsSource);
  const foods: ParsedFood[] = [];

  for (const field of fields) {
    const calls = expandBuilderCallsFromHelpers(field.initializer, builderHelpers);

    let nutrition: number | null = null;
    let saturationModifier: number | null = null;
    let alwaysEdible = false;
    let usingConvertsTo: string | null = null;
    const effects: Array<{ effect: string; probability: number | null }> = [];

    for (const call of calls) {
      if (call.name === "nutrition" && call.args.length > 0) {
        const value = parseIntegerLiteral(call.args[0]);
        if (value !== null) {
          nutrition = value;
        }
        continue;
      }

      if (call.name === "saturationModifier" && call.args.length > 0) {
        const value = parseFloatLiteral(call.args[0]);
        if (value !== null) {
          saturationModifier = value;
        }
        continue;
      }

      if (call.name === "alwaysEdible") {
        alwaysEdible = true;
        continue;
      }

      if (call.name === "usingConvertsTo" && call.args.length > 0) {
        usingConvertsTo = call.args[0].trim();
        continue;
      }

      if (call.name === "effect" && call.args.length > 0) {
        const probability =
          call.args.length > 1 ? parseFloatLiteral(call.args[1]) : null;
        effects.push({
          effect: call.args[0].trim(),
          probability,
        });
        continue;
      }
    }

    foods.push({
      fieldName: field.name,
      id: toSnakeCaseFromConstant(field.name),
      reference: `Foods.${field.name}`,
      initializer: field.initializer,
      nutrition,
      saturationModifier,
      alwaysEdible,
      usingConvertsTo,
      effects,
      propertyCalls: calls.map((call) => ({
        name: call.name,
        args: call.args,
      })),
    });
  }

  return foods;
}

export function parseCreativeModeTabs(
  creativeModeTabsSource: string,
): ParsedCreativeTab[] {
  const javaIdentifier = String.raw`[$A-Za-z_][$A-Za-z0-9_]*`;
  const keyFieldToId = new Map<string, string>();
  const keyPattern =
    /private\s+static\s+final\s+ResourceKey<CreativeModeTab>\s+([A-Z0-9_]+)\s*=\s*CreativeModeTabs\.createKey\(\s*"([^"]+)"\s*\)\s*;/g;
  let keyMatch: RegExpExecArray | null = null;
  while ((keyMatch = keyPattern.exec(creativeModeTabsSource)) !== null) {
    keyFieldToId.set(keyMatch[1], keyMatch[2]);
  }

  const tabs: ParsedCreativeTab[] = [];
  const registerPattern = new RegExp(
    String.raw`Registry\.register\s*\(\s*${javaIdentifier}\s*,\s*([A-Z0-9_]+)\s*,`,
    "g",
  );
  let registerMatch: RegExpExecArray | null = null;
  while ((registerMatch = registerPattern.exec(creativeModeTabsSource)) !== null) {
    const tabFieldName = registerMatch[1];
    const statementStart = registerMatch.index;
    const statementEnd = findStatementEnd(creativeModeTabsSource, registerPattern.lastIndex);
    if (statementEnd === -1) {
      continue;
    }

    const statement = creativeModeTabsSource.slice(statementStart, statementEnd + 1);
    const displayItemsPattern = new RegExp(
      String.raw`\.displayItems\s*\(\s*\(\s*${javaIdentifier}\s*,\s*(${javaIdentifier})\s*\)\s*->\s*\{`,
    );
    const displayItemsMatch = displayItemsPattern.exec(statement);
    const itemFields = new Set<string>();

    if (displayItemsMatch) {
      const openBraceOffset =
        displayItemsMatch.index + displayItemsMatch[0].lastIndexOf("{");
      const closeBraceOffset = findMatchingBrace(statement, openBraceOffset);
      if (closeBraceOffset !== -1) {
        const body = statement.slice(openBraceOffset + 1, closeBraceOffset);
        const itemReferencePattern = /\bItems\.([A-Z0-9_]+)\b/g;
        let itemReferenceMatch: RegExpExecArray | null = null;
        while ((itemReferenceMatch = itemReferencePattern.exec(body)) !== null) {
          itemFields.add(itemReferenceMatch[1]);
        }
      }
    }

    tabs.push({
      fieldName: tabFieldName,
      id: keyFieldToId.get(tabFieldName) ?? toSnakeCaseFromConstant(tabFieldName),
      itemFields: Array.from(itemFields),
    });

    registerPattern.lastIndex = statementEnd + 1;
  }

  return tabs;
}

function parseRegisterItemId(rawFirstArg: string | undefined, fallbackId: string): string {
  if (!rawFirstArg) {
    return fallbackId;
  }
  const literal = parseJavaStringLiteral(rawFirstArg);
  if (literal !== null) {
    return stripMinecraftNamespace(literal);
  }

  const vanillaItemIdMatch = /vanillaItemId\(\s*"([^"]+)"\s*\)/.exec(rawFirstArg);
  if (vanillaItemIdMatch) {
    return stripMinecraftNamespace(vanillaItemIdMatch[1]);
  }

  const defaultNamespaceMatch =
    /Identifier\.withDefaultNamespace\(\s*"([^"]+)"\s*\)/.exec(rawFirstArg);
  if (defaultNamespaceMatch) {
    return stripMinecraftNamespace(defaultNamespaceMatch[1]);
  }

  return fallbackId;
}

function deriveSpawnEggId(rawArg: string | undefined, fallbackId: string): string {
  if (!rawArg) {
    return fallbackId;
  }
  const entityMatch = /EntityType\.([A-Z0-9_]+)/.exec(rawArg);
  if (!entityMatch) {
    return fallbackId;
  }
  return `${entityMatch[1].toLowerCase()}_spawn_egg`;
}

function getUnqualifiedMethodName(name: string): string {
  const trimmed = name.trim();
  const lastDot = trimmed.lastIndexOf(".");
  return lastDot === -1 ? trimmed : trimmed.slice(lastDot + 1);
}

function isPropertiesConstructorExpression(arg: string): boolean {
  return /\bnew\s+(?:[A-Za-z0-9_$.]+\.)?Properties\s*\(/.test(arg);
}

function extractPropertiesExpressionFromRegistration(
  registrationName: string,
  args: string[],
): string | null {
  for (const arg of args) {
    if (isPropertiesConstructorExpression(arg)) {
      return arg.trim();
    }
  }

  if (registrationName === "registerSpawnEgg") {
    const entityArg = args[0] ?? "type";
    return `new Item.Properties().spawnEgg(${entityArg})`;
  }

  return null;
}

function computeItemProperties(calls: MethodCall[]): {
  maxStackSize: number;
  maxDamage: number | null;
  rarity: string | null;
  fireResistant: boolean;
  foodReference: string | null;
} {
  const unstackablePropertyMethods = new Set([
    "sword",
    "pickaxe",
    "spear",
    "humanoidArmor",
    "horseArmor",
    "nautilusArmor",
    "wolfArmor",
  ]);

  let maxStackSize = 64;
  let maxDamage: number | null = null;
  let rarity: string | null = null;
  let fireResistant = false;
  let foodReference: string | null = null;

  for (const call of calls) {
    if (call.name === "stacksTo" && call.args.length >= 1) {
      const value = parseIntegerLiteral(call.args[0]);
      if (value !== null) {
        maxStackSize = value;
      }
      continue;
    }

    if ((call.name === "durability" || call.name === "maxDamage") && call.args.length >= 1) {
      const value = parseIntegerLiteral(call.args[0]);
      if (value !== null) {
        maxDamage = value;
        maxStackSize = 1;
      }
      continue;
    }

    if (call.name === "rarity" && call.args.length >= 1) {
      rarity = call.args[0].trim();
      continue;
    }

    if (call.name === "fireResistant") {
      fireResistant = true;
      continue;
    }

    if (unstackablePropertyMethods.has(call.name)) {
      maxStackSize = 1;
      continue;
    }

    if (call.name === "food" && call.args.length >= 1) {
      foodReference = call.args[0].trim();
      continue;
    }

    if (
      call.name === "component" &&
      call.args.length >= 2 &&
      call.args[0].replace(/\s+/g, "") === "DataComponents.MAX_STACK_SIZE"
    ) {
      const value = parseIntegerLiteral(call.args[1]);
      if (value !== null) {
        maxStackSize = value;
      }
      continue;
    }
  }

  return {
    maxStackSize,
    maxDamage,
    rarity,
    fireResistant,
    foodReference,
  };
}

function isUnstackableItemFactory(itemFactory: string | null): boolean {
  if (!itemFactory) {
    return false;
  }

  // Some tools are created via factory lambdas without explicit properties chains.
  // Example: "(Item.Properties p) -> new AxeItem(..., p)"
  return /new\s+(?:[A-Za-z0-9_$.]+\.)?(?:AnimalArmorItem|ArmorItem|AxeItem|HoeItem|PickaxeItem|ShovelItem|SwordItem)\s*\(/.test(
    itemFactory,
  );
}

export function parseItems(itemsSource: string, blockMap: Map<string, ParsedBlock>): ParsedItem[] {
  const fields = extractStaticFieldInitializers(itemsSource, "Item");
  const items: ParsedItem[] = [];

  for (const field of fields) {
    const outerCall = parseTopLevelCall(field.initializer);
    const fallbackId = toSnakeCaseFromConstant(field.name);

    let registration: ParsedItem["registration"] = "other";
    let id = fallbackId;
    let blockField: string | null = null;
    let itemFactory: string | null = null;
    let propertiesExpression: string | null = null;

    if (outerCall) {
      const registrationName = getUnqualifiedMethodName(outerCall.name);

      if (registrationName === "registerBlock") {
        registration = "block";
        blockField = parseBlockFieldReference(outerCall.args[0] ?? "") ?? null;
        if (blockField && blockMap.has(blockField)) {
          id = blockMap.get(blockField)!.id;
        }
        if (
          outerCall.args.length >= 2 &&
          !isPropertiesConstructorExpression(outerCall.args[1])
        ) {
          itemFactory = outerCall.args[1].trim();
        }
      } else if (registrationName === "registerItem") {
        registration = "item";
        id = parseRegisterItemId(outerCall.args[0], fallbackId);
        if (
          outerCall.args.length >= 2 &&
          !isPropertiesConstructorExpression(outerCall.args[1])
        ) {
          itemFactory = outerCall.args[1].trim();
        }
      } else if (registrationName === "registerSpawnEgg") {
        registration = "spawn_egg";
        id = deriveSpawnEggId(outerCall.args[0], fallbackId);
      }

      propertiesExpression = extractPropertiesExpressionFromRegistration(
        registrationName,
        outerCall.args,
      );
    }

    const propertyCalls = propertiesExpression ? extractMethodCalls(propertiesExpression) : [];
    const computedProperties = computeItemProperties(propertyCalls);
    if (isUnstackableItemFactory(itemFactory) && computedProperties.maxStackSize > 1) {
      computedProperties.maxStackSize = 1;
    }
    const blockLoot = blockField ? blockMap.get(blockField)?.loot ?? null : null;

    items.push({
      fieldName: field.name,
      id,
      registration,
      blockField,
      itemFactory,
      propertiesExpression,
      maxStackSize: computedProperties.maxStackSize,
      maxDamage: computedProperties.maxDamage,
      rarity: computedProperties.rarity,
      fireResistant: computedProperties.fireResistant,
      foodReference: computedProperties.foodReference,
      propertyCalls: propertyCalls.map((call) => ({
        name: call.name,
        args: call.args,
      })),
      blockLoot,
    });
  }

  return items;
}

export function parseVanillaBlockLoot(source: string): VanillaBlockLootEntry[] {
  const entries = new Map<string, VanillaBlockLootEntry>();

  const generatePattern = /protected\s+void\s+generate\s*\(\s*\)\s*\{/;
  const match = generatePattern.exec(source);
  if (!match) {
    return [];
  }

  const openBrace = match.index + match[0].length - 1;
  const closeBrace = findMatchingBrace(source, openBrace);
  if (closeBrace === -1) {
    return [];
  }

  const body = source.slice(openBrace + 1, closeBrace);

  let m: RegExpExecArray | null;

  const dropSelfPattern = /\bthis\.dropSelf\(\s*Blocks\.([A-Z0-9_]+)\s*\)/g;
  while ((m = dropSelfPattern.exec(body)) !== null) {
    entries.set(m[1], { blockField: m[1], lootMethod: "drop_self", lootDropField: null });
  }

  const dropSilkPattern = /\bthis\.dropWhenSilkTouch\(\s*Blocks\.([A-Z0-9_]+)\s*\)/g;
  while ((m = dropSilkPattern.exec(body)) !== null) {
    entries.set(m[1], { blockField: m[1], lootMethod: "drop_when_silk_touch", lootDropField: null });
  }

  const dropOtherPattern =
    /\bthis\.dropOther\(\s*Blocks\.([A-Z0-9_]+)\s*,\s*(?:\([^)]+\)\s*)?(?:Blocks|Items)\.([A-Z0-9_]+)\s*\)/g;
  while ((m = dropOtherPattern.exec(body)) !== null) {
    entries.set(m[1], { blockField: m[1], lootMethod: "drop_other", lootDropField: m[2] });
  }

  const noDropPattern = /\bthis\.add\(\s*Blocks\.([A-Z0-9_]+)\s*,\s*noDrop\s*\(\s*\)\s*\)/g;
  while ((m = noDropPattern.exec(body)) !== null) {
    entries.set(m[1], { blockField: m[1], lootMethod: "no_drop", lootDropField: null });
  }

  const addPattern = /\bthis\.add\(\s*Blocks\.([A-Z0-9_]+)\s*,/g;
  while ((m = addPattern.exec(body)) !== null) {
    if (!entries.has(m[1])) {
      entries.set(m[1], { blockField: m[1], lootMethod: "custom", lootDropField: null });
    }
  }

  return Array.from(entries.values());
}
