import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  findMatchingToken,
  findQualifiedReferences,
  findStatementEnd,
  findStatementStart,
  firstQualifiedReference,
  firstStringLiteral,
  isNameToken,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  unique,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";

export type CreativeModeTabKey = {
  fieldName: string;
  id: string;
  source: string;
  range: SourceRange;
};

export type CreativeModeTabAcceptedEntry = {
  kind: "accept" | "accept_all" | "helper_call" | "generated_variant";
  receiver: string | null;
  methodName: string;
  generatorName: string | null;
  variantKind: string | null;
  variantSourceExpression: string | null;
  variantValueExpression: string | null;
  itemField: string | null;
  itemFields: string[];
  stackExpression: string | null;
  visibilityExpression: string | null;
  conditionExpression: string | null;
  source: string;
  range: SourceRange;
};

export type CreativeModeTabDisplayItems = {
  parametersName: string | null;
  outputName: string | null;
  bodySource: string;
  range: SourceRange;
  entries: CreativeModeTabAcceptedEntry[];
};

export type CreativeModeTabRegistration = {
  fieldName: string;
  id: string;
  registryExpression: string;
  builderExpression: string;
  rowExpression: string | null;
  row: string | null;
  column: number | null;
  titleExpression: string | null;
  titleTranslationKey: string | null;
  iconExpression: string | null;
  iconItemField: string | null;
  iconBlockField: string | null;
  backgroundTextureExpression: string | null;
  typeExpression: string | null;
  flags: string[];
  displayItems: CreativeModeTabDisplayItems | null;
  itemFields: string[];
  source: string;
  range: SourceRange;
};

export type CreativeModeTabsParseResult = {
  keys: CreativeModeTabKey[];
  tabs: CreativeModeTabRegistration[];
  keyByFieldName: Record<string, CreativeModeTabKey>;
  tabByFieldName: Record<string, CreativeModeTabRegistration>;
  itemFieldToTabIds: Record<string, string[]>;
  diagnostics: ParserDiagnostic[];
};

type ConditionalRange = {
  start: number;
  end: number;
  expression: string;
};

const BUILDER_FLAG_METHODS = new Set([
  "alignedRight",
  "hideTitle",
  "noScrollBar",
  "withSearchBar",
]);

function extractKeys(source: string, tokens: JavaToken[]): CreativeModeTabKey[] {
  const keys: CreativeModeTabKey[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name !== "CreativeModeTabs.createKey") {
      continue;
    }

    const openIndex = qualified.endIndex;
    if (tokens[openIndex]?.value !== "(") {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1) {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }

    let equalsIndex = index - 1;
    while (equalsIndex > statementStart && tokens[equalsIndex].value !== "=") {
      equalsIndex -= 1;
    }
    if (tokens[equalsIndex]?.value !== "=") {
      continue;
    }

    let fieldIndex = equalsIndex - 1;
    while (fieldIndex >= statementStart && !isNameToken(tokens[fieldIndex])) {
      fieldIndex -= 1;
    }
    if (fieldIndex < statementStart) {
      continue;
    }

    const id = firstStringLiteral(tokens, openIndex + 1, closeIndex);
    if (!id) {
      continue;
    }

    keys.push({
      fieldName: tokens[fieldIndex].value,
      id,
      source: tokenSource(source, tokens, statementStart, statementEnd + 1),
      range: tokenRange(tokens, statementStart, statementEnd + 1),
    });
  }

  return keys;
}

function parseBuilderCall(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  diagnostics: ParserDiagnostic[],
): {
  rowExpression: string | null;
  row: string | null;
  column: number | null;
  titleExpression: string | null;
  titleTranslationKey: string | null;
  iconExpression: string | null;
  iconItemField: string | null;
  iconBlockField: string | null;
  backgroundTextureExpression: string | null;
  typeExpression: string | null;
  flags: string[];
  displayItems: CreativeModeTabDisplayItems | null;
} {
  let rowExpression: string | null = null;
  let row: string | null = null;
  let column: number | null = null;
  let titleExpression: string | null = null;
  let titleTranslationKey: string | null = null;
  let iconExpression: string | null = null;
  let iconItemField: string | null = null;
  let iconBlockField: string | null = null;
  let backgroundTextureExpression: string | null = null;
  let typeExpression: string | null = null;
  const flags: string[] = [];
  let displayItems: CreativeModeTabDisplayItems | null = null;

  for (let index = startIndex; index < endIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name === "CreativeModeTab.builder" && tokens[qualified.endIndex]?.value === "(") {
      const closeIndex = findMatchingToken(tokens, qualified.endIndex);
      if (closeIndex !== -1) {
        const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex);
        const rowArg = args[0];
        const columnArg = args[1];
        if (rowArg) {
          rowExpression = tokenSource(source, tokens, rowArg.startIndex, rowArg.endIndex);
          row = tokens[rowArg.endIndex - 1]?.value ?? null;
        }
        if (columnArg) {
          const rawColumn = tokenSource(source, tokens, columnArg.startIndex, columnArg.endIndex);
          const parsedColumn = Number(rawColumn);
          column = Number.isFinite(parsedColumn) ? parsedColumn : null;
        }
      }
    }

    if (tokens[index].value !== "." || !isNameToken(tokens[index + 1]) || tokens[index + 2]?.value !== "(") {
      continue;
    }

    const methodName = tokens[index + 1].value;
    const openIndex = index + 2;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1) {
      continue;
    }

    const args = splitTopLevelArguments(tokens, openIndex + 1, closeIndex);
    const firstArg = args[0];
    if (methodName === "title" && firstArg) {
      titleExpression = tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex);
      titleTranslationKey = firstStringLiteral(tokens, firstArg.startIndex, firstArg.endIndex);
    } else if (methodName === "icon" && firstArg) {
      iconExpression = tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex);
      iconItemField = firstQualifiedReference(tokens, firstArg.startIndex, firstArg.endIndex, "Items");
      iconBlockField = firstQualifiedReference(tokens, firstArg.startIndex, firstArg.endIndex, "Blocks");
    } else if (methodName === "backgroundTexture" && firstArg) {
      backgroundTextureExpression = tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex);
    } else if (methodName === "type" && firstArg) {
      typeExpression = tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex);
    } else if (methodName === "displayItems" && firstArg) {
      displayItems = parseDisplayItems(
        source,
        tokens,
        firstArg.startIndex,
        firstArg.endIndex,
        diagnostics,
      );
    } else if (BUILDER_FLAG_METHODS.has(methodName)) {
      flags.push(methodName);
    }
  }

  return {
    rowExpression,
    row,
    column,
    titleExpression,
    titleTranslationKey,
    iconExpression,
    iconItemField,
    iconBlockField,
    backgroundTextureExpression,
    typeExpression,
    flags: unique(flags),
    displayItems,
  };
}

function parseDisplayItems(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  diagnostics: ParserDiagnostic[],
): CreativeModeTabDisplayItems | null {
  let arrowIndex = -1;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].value === "->") {
      arrowIndex = index;
      break;
    }
  }
  if (arrowIndex === -1) {
    diagnostics.push({
      code: "creative_tabs.display_items.no_lambda",
      message: "displayItems argument did not contain a parseable lambda.",
      severity: "warning",
      range: tokenRange(tokens, startIndex, endIndex),
      source: tokenSource(source, tokens, startIndex, endIndex),
    });
    return null;
  }

  const lambdaParams = parseLambdaParameters(tokens, startIndex, arrowIndex);
  const bodyOpenIndex = tokens[arrowIndex + 1]?.value === "{" ? arrowIndex + 1 : -1;
  if (bodyOpenIndex === -1) {
    diagnostics.push({
      code: "creative_tabs.display_items.no_block_body",
      message: "displayItems lambda did not use a parseable block body.",
      severity: "warning",
      range: tokenRange(tokens, startIndex, endIndex),
      source: tokenSource(source, tokens, startIndex, endIndex),
    });
    return null;
  }
  const bodyCloseIndex = findMatchingToken(tokens, bodyOpenIndex);
  if (bodyCloseIndex === -1) {
    diagnostics.push({
      code: "creative_tabs.display_items.unclosed_body",
      message: "displayItems lambda body did not have a matching closing brace.",
      severity: "warning",
      range: tokenRange(tokens, bodyOpenIndex, Math.min(bodyOpenIndex + 1, tokens.length)),
      source: tokenSource(source, tokens, bodyOpenIndex, Math.min(bodyOpenIndex + 1, tokens.length)),
    });
    return null;
  }

  const conditionRanges = collectConditionalRanges(source, tokens, bodyOpenIndex + 1, bodyCloseIndex);
  return {
    parametersName: lambdaParams[0] ?? null,
    outputName: lambdaParams[1] ?? null,
    bodySource: source.slice(tokens[bodyOpenIndex].end, tokens[bodyCloseIndex].start),
    range: tokenRange(tokens, bodyOpenIndex, bodyCloseIndex + 1),
    entries: extractDisplayEntries(
      source,
      tokens,
      bodyOpenIndex + 1,
      bodyCloseIndex,
      lambdaParams[1] ?? null,
      conditionRanges,
      diagnostics,
    ),
  };
}

function parseLambdaParameters(tokens: JavaToken[], startIndex: number, arrowIndex: number): string[] {
  if (tokens[startIndex]?.value === "(") {
    const closeIndex = findMatchingToken(tokens, startIndex);
    if (closeIndex !== -1 && closeIndex < arrowIndex) {
      return splitTopLevelArguments(tokens, startIndex + 1, closeIndex)
        .map((slice) => {
          for (let index = slice.endIndex - 1; index >= slice.startIndex; index -= 1) {
            if (tokens[index].kind === "identifier") {
              return tokens[index].value;
            }
          }
          return null;
        })
        .filter((value): value is string => value !== null);
    }
  }

  return tokens[startIndex]?.kind === "identifier" ? [tokens[startIndex].value] : [];
}

function collectConditionalRanges(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): ConditionalRange[] {
  const ranges: ConditionalRange[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].value !== "if" || tokens[index + 1]?.value !== "(") {
      continue;
    }

    const conditionCloseIndex = findMatchingToken(tokens, index + 1);
    if (conditionCloseIndex === -1) {
      continue;
    }
    const bodyOpenIndex = tokens[conditionCloseIndex + 1]?.value === "{" ? conditionCloseIndex + 1 : -1;
    if (bodyOpenIndex === -1) {
      continue;
    }
    const bodyCloseIndex = findMatchingToken(tokens, bodyOpenIndex);
    if (bodyCloseIndex === -1) {
      continue;
    }

    ranges.push({
      start: tokens[bodyOpenIndex].end,
      end: tokens[bodyCloseIndex].start,
      expression: tokenSource(source, tokens, index + 2, conditionCloseIndex),
    });
  }
  return ranges;
}

function conditionForOffset(ranges: ConditionalRange[], offset: number): string | null {
  const expressions = ranges
    .filter((range) => range.start <= offset && offset <= range.end)
    .map((range) => range.expression);
  return expressions.length > 0 ? expressions.join(" && ") : null;
}

function argSource(
  source: string,
  tokens: JavaToken[],
  args: TokenSlice[],
  index: number,
): string | null {
  const arg = args[index];
  return arg ? tokenSource(source, tokens, arg.startIndex, arg.endIndex) : null;
}

function argItemField(tokens: JavaToken[], args: TokenSlice[], index: number): string | null {
  const arg = args[index];
  return arg ? firstQualifiedReference(tokens, arg.startIndex, arg.endIndex, "Items") : null;
}

function buildGeneratedEntry(input: {
  source: string;
  tokens: JavaToken[];
  startIndex: number;
  endIndex: number;
  methodName: string;
  itemField: string | null;
  stackExpression: string | null;
  visibilityExpression: string | null;
  variantKind: string;
  variantSourceExpression: string | null;
  variantValueExpression: string | null;
  conditionExpression: string | null;
}): CreativeModeTabAcceptedEntry {
  return {
    kind: "generated_variant",
    receiver: "CreativeModeTabs",
    methodName: input.methodName,
    generatorName: input.methodName,
    variantKind: input.variantKind,
    variantSourceExpression: input.variantSourceExpression,
    variantValueExpression: input.variantValueExpression,
    itemField: input.itemField,
    itemFields: input.itemField ? [input.itemField] : [],
    stackExpression: input.stackExpression,
    visibilityExpression: input.visibilityExpression,
    conditionExpression: input.conditionExpression,
    source: tokenSource(input.source, input.tokens, input.startIndex, input.endIndex),
    range: tokenRange(input.tokens, input.startIndex, input.endIndex),
  };
}

function expandCreativeModeTabGenerator(input: {
  source: string;
  tokens: JavaToken[];
  startIndex: number;
  endIndex: number;
  methodName: string;
  args: TokenSlice[];
  conditionExpression: string | null;
}): CreativeModeTabAcceptedEntry[] {
  const { source, tokens, startIndex, endIndex, methodName, args, conditionExpression } = input;
  const unqualifiedName = methodName.split(".").at(-1) ?? methodName;

  if (unqualifiedName === "generatePotionEffectTypes") {
    const itemField = argItemField(tokens, args, 2);
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField,
        stackExpression: argSource(source, tokens, args, 2),
        visibilityExpression: argSource(source, tokens, args, 3),
        variantKind: "potion_effect_type",
        variantSourceExpression: argSource(source, tokens, args, 1),
        variantValueExpression:
          "potions.listElements().filter(potion -> ((Potion)potion.value()).isEnabled(enabledFeatures))",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generateEnchantmentBookTypesOnlyMaxLevel") {
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "ENCHANTED_BOOK",
        stackExpression: "EnchantmentHelper.createBook(...)",
        visibilityExpression: argSource(source, tokens, args, 2),
        variantKind: "enchantment_max_level",
        variantSourceExpression: argSource(source, tokens, args, 1),
        variantValueExpression:
          "enchantments.listElements().map(enchantment -> maxLevel book)",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generateEnchantmentBookTypesAllLevels") {
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "ENCHANTED_BOOK",
        stackExpression: "EnchantmentHelper.createBook(...)",
        visibilityExpression: argSource(source, tokens, args, 2),
        variantKind: "enchantment_each_level",
        variantSourceExpression: argSource(source, tokens, args, 1),
        variantValueExpression:
          "enchantments.listElements().flatMap(enchantment -> minLevel..maxLevel books)",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generateInstrumentTypes") {
    const itemField = argItemField(tokens, args, 2);
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField,
        stackExpression: argSource(source, tokens, args, 2),
        visibilityExpression: argSource(source, tokens, args, 4),
        variantKind: "instrument_tag_entry",
        variantSourceExpression: argSource(source, tokens, args, 3),
        variantValueExpression: "instruments.get(instrumentTagKey).stream()",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generateSuspiciousStews") {
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "SUSPICIOUS_STEW",
        stackExpression: "new ItemStack(Items.SUSPICIOUS_STEW)",
        visibilityExpression: argSource(source, tokens, args, 1),
        variantKind: "suspicious_stew_effect_holder",
        variantSourceExpression: "SuspiciousEffectHolder.getAllEffectHolders()",
        variantValueExpression: "effectHolder.getSuspiciousEffects()",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generateOminousBottles") {
    return [0, 1, 2, 3, 4].map((amplifier) =>
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "OMINOUS_BOTTLE",
        stackExpression: "new ItemStack(Items.OMINOUS_BOTTLE)",
        visibilityExpression: argSource(source, tokens, args, 1),
        variantKind: "ominous_bottle_amplifier",
        variantSourceExpression: "0..4",
        variantValueExpression: String(amplifier),
        conditionExpression,
      }),
    );
  }

  if (unqualifiedName === "generateFireworksAllDurations") {
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "FIREWORK_ROCKET",
        stackExpression: "new ItemStack(Items.FIREWORK_ROCKET)",
        visibilityExpression: argSource(source, tokens, args, 1),
        variantKind: "firework_craftable_duration",
        variantSourceExpression: "FireworkRocketItem.CRAFTABLE_DURATIONS",
        variantValueExpression: "duration",
        conditionExpression,
      }),
    ];
  }

  if (unqualifiedName === "generatePresetPaintings") {
    return [
      buildGeneratedEntry({
        source,
        tokens,
        startIndex,
        endIndex,
        methodName,
        itemField: "PAINTING",
        stackExpression: "new ItemStack(Items.PAINTING)",
        visibilityExpression: argSource(source, tokens, args, 4),
        variantKind: "painting_variant",
        variantSourceExpression: argSource(source, tokens, args, 2),
        variantValueExpression: argSource(source, tokens, args, 3),
        conditionExpression,
      }),
    ];
  }

  return [];
}

function extractDisplayEntries(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  outputName: string | null,
  conditionRanges: ConditionalRange[],
  diagnostics: ParserDiagnostic[],
): CreativeModeTabAcceptedEntry[] {
  const entries: CreativeModeTabAcceptedEntry[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    if (!isNameToken(tokens[index]) || tokens[index + 1]?.value !== "." || !isNameToken(tokens[index + 2]) || tokens[index + 3]?.value !== "(") {
      continue;
    }

    const receiver = tokens[index].value;
    const methodName = tokens[index + 2].value;
    const openIndex = index + 3;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex > endIndex) {
      diagnostics.push({
        code: "creative_tabs.display_call.unclosed",
        message: `Display items call '${receiver}.${methodName}' did not have a matching closing parenthesis.`,
        severity: "warning",
        range: tokenRange(tokens, index, Math.min(openIndex + 1, tokens.length)),
        source: tokenSource(source, tokens, index, Math.min(openIndex + 1, tokens.length)),
      });
      continue;
    }

    if (receiver === outputName && methodName !== "accept" && methodName !== "acceptAll") {
      diagnostics.push({
        code: "creative_tabs.display_call.unhandled_output_method",
        message: `Unhandled creative tab output method '${methodName}'.`,
        severity: "warning",
        range: tokenRange(tokens, index, closeIndex + 1),
        source: tokenSource(source, tokens, index, closeIndex + 1),
      });
      index = closeIndex;
      continue;
    }

    if (receiver === outputName && (methodName === "accept" || methodName === "acceptAll")) {
      const args = splitTopLevelArguments(tokens, openIndex + 1, closeIndex);
      const firstArg = args[0] ?? null;
      const secondArg = args[1] ?? null;
      entries.push({
        kind: methodName === "accept" ? "accept" : "accept_all",
        receiver,
        methodName,
        generatorName: null,
        variantKind: null,
        variantSourceExpression: null,
        variantValueExpression: null,
        itemField: firstArg
          ? firstQualifiedReference(tokens, firstArg.startIndex, firstArg.endIndex, "Items")
          : null,
        itemFields: firstArg
          ? unique(findQualifiedReferences(tokens, firstArg.startIndex, firstArg.endIndex, "Items"))
          : [],
        stackExpression: firstArg
          ? tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex)
          : null,
        visibilityExpression: secondArg
          ? tokenSource(source, tokens, secondArg.startIndex, secondArg.endIndex)
          : null,
        conditionExpression: conditionForOffset(conditionRanges, tokens[index].start),
        source: tokenSource(source, tokens, index, closeIndex + 1),
        range: tokenRange(tokens, index, closeIndex + 1),
      });
      index = closeIndex;
      continue;
    }

    const qualified = readQualifiedNameAt(tokens, index);
    if (
      qualified?.name.startsWith("CreativeModeTabs.generate") &&
      tokens[qualified.endIndex]?.value === "("
    ) {
      const helperCloseIndex = findMatchingToken(tokens, qualified.endIndex);
      if (helperCloseIndex === -1 || helperCloseIndex > endIndex) {
        diagnostics.push({
          code: "creative_tabs.generator.unclosed",
          message: `CreativeModeTabs generator '${qualified.name}' did not have a matching closing parenthesis.`,
          severity: "warning",
          range: tokenRange(tokens, index, Math.min(qualified.endIndex + 1, tokens.length)),
          source: tokenSource(source, tokens, index, Math.min(qualified.endIndex + 1, tokens.length)),
        });
        continue;
      }
      const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, helperCloseIndex);
      const conditionExpression = conditionForOffset(conditionRanges, tokens[index].start);
      const generatedEntries = expandCreativeModeTabGenerator({
        source,
        tokens,
        startIndex: index,
        endIndex: helperCloseIndex + 1,
        methodName: qualified.name,
        args,
        conditionExpression,
      });

      if (generatedEntries.length > 0) {
        entries.push(...generatedEntries);
      } else {
        diagnostics.push({
          code: "creative_tabs.generator.unhandled",
          message: `CreativeModeTabs generator '${qualified.name}' does not have a specialized parser yet.`,
          severity: "warning",
          range: tokenRange(tokens, index, helperCloseIndex + 1),
          source: tokenSource(source, tokens, index, helperCloseIndex + 1),
        });
        entries.push({
          kind: "helper_call",
          receiver: "CreativeModeTabs",
          methodName: qualified.name,
          generatorName: qualified.name,
          variantKind: null,
          variantSourceExpression: null,
          variantValueExpression: null,
          itemField: null,
          itemFields: unique(
            findQualifiedReferences(tokens, qualified.endIndex + 1, helperCloseIndex, "Items"),
          ),
          stackExpression: args[0]
            ? tokenSource(source, tokens, args[0].startIndex, args[0].endIndex)
            : null,
          visibilityExpression: null,
          conditionExpression,
          source: tokenSource(source, tokens, index, helperCloseIndex + 1),
          range: tokenRange(tokens, index, helperCloseIndex + 1),
        });
      }
      index = helperCloseIndex;
    }
  }

  return entries;
}

export function parseCreativeModeTabsSource(source: string): CreativeModeTabsParseResult {
  const tokens = tokenizeJava(source);
  const diagnostics: ParserDiagnostic[] = [];
  const keys = extractKeys(source, tokens);
  const keyByFieldName = Object.fromEntries(keys.map((key) => [key.fieldName, key]));
  const tabs: CreativeModeTabRegistration[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name !== "Registry.register" || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    const statementEnd = findStatementEnd(tokens, index);
    if (closeIndex === -1 || statementEnd === -1) {
      diagnostics.push({
        code: "creative_tabs.registration.malformed",
        message: "Registry.register call could not be parsed as a complete statement.",
        severity: "warning",
        range: tokenRange(tokens, index, Math.min(openIndex + 1, tokens.length)),
        source: tokenSource(source, tokens, index, Math.min(openIndex + 1, tokens.length)),
      });
      continue;
    }

    const args = splitTopLevelArguments(tokens, openIndex + 1, closeIndex);
    const registryArg = args[0];
    const keyArg = args[1];
    const builderArg = args[2];
    if (!registryArg || !keyArg || !builderArg) {
      diagnostics.push({
        code: "creative_tabs.registration.missing_args",
        message: "Registry.register call did not include registry, key, and builder arguments.",
        severity: "warning",
        range: tokenRange(tokens, index, statementEnd + 1),
        source: tokenSource(source, tokens, index, statementEnd + 1),
      });
      continue;
    }

    const fieldName = tokenSource(source, tokens, keyArg.startIndex, keyArg.endIndex);
    const key = keyByFieldName[fieldName] ?? null;
    if (!key) {
      diagnostics.push({
        code: "creative_tabs.registration.missing_key",
        message: `Creative tab registration '${fieldName}' did not match a parsed CreativeModeTabs.createKey field.`,
        severity: "warning",
        range: tokenRange(tokens, keyArg.startIndex, keyArg.endIndex),
        source: tokenSource(source, tokens, keyArg.startIndex, keyArg.endIndex),
      });
    }
    const builder = parseBuilderCall(
      source,
      tokens,
      builderArg.startIndex,
      builderArg.endIndex,
      diagnostics,
    );
    const itemFields = unique(builder.displayItems?.entries.flatMap((entry) => entry.itemFields) ?? []);

    tabs.push({
      fieldName,
      id: key?.id ?? fieldName.toLowerCase(),
      registryExpression: tokenSource(source, tokens, registryArg.startIndex, registryArg.endIndex),
      builderExpression: tokenSource(source, tokens, builderArg.startIndex, builderArg.endIndex),
      rowExpression: builder.rowExpression,
      row: builder.row,
      column: builder.column,
      titleExpression: builder.titleExpression,
      titleTranslationKey: builder.titleTranslationKey,
      iconExpression: builder.iconExpression,
      iconItemField: builder.iconItemField,
      iconBlockField: builder.iconBlockField,
      backgroundTextureExpression: builder.backgroundTextureExpression,
      typeExpression: builder.typeExpression,
      flags: builder.flags,
      displayItems: builder.displayItems,
      itemFields,
      source: tokenSource(source, tokens, index, statementEnd + 1),
      range: tokenRange(tokens, index, statementEnd + 1),
    });

    index = statementEnd;
  }

  const tabByFieldName = Object.fromEntries(tabs.map((tab) => [tab.fieldName, tab]));
  const itemFieldToTabIds: Record<string, string[]> = {};
  for (const tab of tabs) {
    for (const itemField of tab.itemFields) {
      itemFieldToTabIds[itemField] = [...(itemFieldToTabIds[itemField] ?? []), tab.id];
    }
  }

  return {
    keys,
    tabs,
    keyByFieldName,
    tabByFieldName,
    itemFieldToTabIds,
    diagnostics,
  };
}
