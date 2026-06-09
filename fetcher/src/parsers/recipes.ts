import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RecipeIngredient =
  | {
      kind: "item";
      id: string;
      raw: JsonValue;
    }
  | {
      kind: "tag";
      id: string;
      raw: JsonValue;
    }
  | {
      kind: "alternatives";
      alternatives: RecipeIngredient[];
      raw: JsonValue;
    }
  | {
      kind: "unknown";
      raw: JsonValue;
    };

export type RecipeResult = {
  id: string | null;
  count: number;
  components: JsonObject | null;
  raw: JsonValue;
};

export type ParsedRecipe = {
  id: string;
  namespace: string;
  path: string;
  filePath: string | null;
  type: string;
  group: string | null;
  category: string | null;
  showNotification: boolean | null;
  result: RecipeResult | null;
  ingredients: RecipeIngredient[];
  raw: JsonObject;
  data: Record<string, JsonValue>;
  diagnostics: ParserDiagnostic[];
};

export type RecipesParseResult = {
  recipes: ParsedRecipe[];
  recipeById: Record<string, ParsedRecipe>;
  recipeTypeCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

const KNOWN_RECIPE_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    "minecraft:blasting": [
      "type",
      "category",
      "cookingtime",
      "experience",
      "group",
      "ingredient",
      "result",
    ],
    "minecraft:campfire_cooking": [
      "type",
      "category",
      "cookingtime",
      "experience",
      "group",
      "ingredient",
      "result",
    ],
    "minecraft:crafting_decorated_pot": [
      "type",
      "back",
      "front",
      "left",
      "result",
      "right",
    ],
    "minecraft:crafting_dye": [
      "type",
      "category",
      "dye",
      "group",
      "result",
      "target",
    ],
    "minecraft:crafting_imbue": ["type", "category", "material", "result", "source"],
    "minecraft:crafting_shaped": [
      "type",
      "category",
      "group",
      "key",
      "pattern",
      "result",
      "show_notification",
    ],
    "minecraft:crafting_shapeless": [
      "type",
      "category",
      "group",
      "ingredients",
      "result",
    ],
    "minecraft:crafting_special_bannerduplicate": ["type", "banner", "result"],
    "minecraft:crafting_special_bookcloning": [
      "type",
      "allowed_generations",
      "material",
      "result",
      "source",
    ],
    "minecraft:crafting_special_firework_rocket": [
      "type",
      "fuel",
      "result",
      "shell",
      "star",
    ],
    "minecraft:crafting_special_firework_star": [
      "type",
      "dye",
      "fuel",
      "result",
      "shapes",
      "trail",
      "twinkle",
    ],
    "minecraft:crafting_special_firework_star_fade": [
      "type",
      "dye",
      "result",
      "target",
    ],
    "minecraft:crafting_special_mapextending": ["type", "map", "material", "result"],
    "minecraft:crafting_special_repairitem": ["type"],
    "minecraft:crafting_special_shielddecoration": [
      "type",
      "banner",
      "result",
      "target",
    ],
    "minecraft:crafting_transmute": [
      "type",
      "add_material_count_to_result",
      "category",
      "group",
      "input",
      "material",
      "material_count",
      "result",
    ],
    "minecraft:smelting": [
      "type",
      "category",
      "cookingtime",
      "experience",
      "group",
      "ingredient",
      "result",
    ],
    "minecraft:smithing_transform": [
      "type",
      "addition",
      "base",
      "result",
      "template",
    ],
    "minecraft:smithing_trim": ["type", "addition", "base", "pattern", "template"],
    "minecraft:smoking": [
      "type",
      "category",
      "cookingtime",
      "experience",
      "ingredient",
      "result",
    ],
    "minecraft:stonecutting": ["type", "ingredient", "result"],
  }).map(([type, keys]) => [type, new Set(keys)]),
);

const INGREDIENT_KEYS_BY_TYPE: Record<string, string[]> = {
  "minecraft:blasting": ["ingredient"],
  "minecraft:campfire_cooking": ["ingredient"],
  "minecraft:crafting_decorated_pot": ["back", "front", "left", "right"],
  "minecraft:crafting_dye": ["target", "dye"],
  "minecraft:crafting_imbue": ["source", "material"],
  "minecraft:crafting_shapeless": ["ingredients"],
  "minecraft:crafting_special_bannerduplicate": ["banner"],
  "minecraft:crafting_special_bookcloning": ["source", "material"],
  "minecraft:crafting_special_firework_rocket": ["shell", "fuel", "star"],
  "minecraft:crafting_special_firework_star": ["fuel", "dye", "trail", "twinkle"],
  "minecraft:crafting_special_firework_star_fade": ["target", "dye"],
  "minecraft:crafting_special_mapextending": ["map", "material"],
  "minecraft:crafting_special_shielddecoration": ["target", "banner"],
  "minecraft:crafting_transmute": ["input", "material"],
  "minecraft:smelting": ["ingredient"],
  "minecraft:smithing_transform": ["template", "base", "addition"],
  "minecraft:smithing_trim": ["template", "base", "addition"],
  "minecraft:smoking": ["ingredient"],
  "minecraft:stonecutting": ["ingredient"],
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function recipeIdFromFile(namespace: string, relativePath: string): string {
  return `${namespace}:${relativePath.replace(/\.json$/, "").replace(/\\/g, "/")}`;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

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

export function parseRecipeIngredient(raw: JsonValue): RecipeIngredient {
  if (typeof raw === "string") {
    return raw.startsWith("#")
      ? { kind: "tag", id: normalizeIdentifier(raw.slice(1)), raw }
      : { kind: "item", id: normalizeIdentifier(raw), raw };
  }

  if (Array.isArray(raw)) {
    return {
      kind: "alternatives",
      alternatives: raw.map(parseRecipeIngredient),
      raw,
    };
  }

  return { kind: "unknown", raw };
}

export function parseRecipeResult(raw: JsonValue | undefined): RecipeResult | null {
  if (typeof raw === "string") {
    return {
      id: normalizeIdentifier(raw),
      count: 1,
      components: null,
      raw,
    };
  }

  if (!isObject(raw)) {
    return null;
  }

  const id = stringValue(raw.id);
  const count = numberValue(raw.count) ?? 1;
  const components = isObject(raw.components) ? raw.components : null;
  return {
    id: id ? normalizeIdentifier(id) : null,
    count,
    components,
    raw,
  };
}

function collectIngredients(type: string, raw: JsonObject): RecipeIngredient[] {
  const ingredients: RecipeIngredient[] = [];

  if (type === "minecraft:crafting_shaped" && isObject(raw.key)) {
    for (const ingredient of Object.values(raw.key)) {
      ingredients.push(parseRecipeIngredient(ingredient));
    }
    return ingredients;
  }

  for (const key of INGREDIENT_KEYS_BY_TYPE[type] ?? []) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (key === "ingredients" && Array.isArray(value)) {
      ingredients.push(...value.map(parseRecipeIngredient));
    } else {
      ingredients.push(parseRecipeIngredient(value));
    }
  }

  if (type === "minecraft:crafting_special_firework_star" && isObject(raw.shapes)) {
    ingredients.push(...Object.values(raw.shapes).map(parseRecipeIngredient));
  }

  return ingredients;
}

function validateRecipeShape(input: {
  id: string;
  type: string;
  raw: JsonObject;
  result: RecipeResult | null;
  ingredients: RecipeIngredient[];
}): ParserDiagnostic[] {
  const diagnostics: ParserDiagnostic[] = [];
  const knownKeys = KNOWN_RECIPE_KEYS[input.type] ?? null;

  if (!knownKeys) {
    diagnostics.push(
      diagnostic({
        code: "recipes.unknown_type",
        message: `Recipe '${input.id}' uses unknown recipe type '${input.type}'.`,
        details: { recipeId: input.id, type: input.type },
      }),
    );
  } else {
    for (const key of Object.keys(input.raw)) {
      if (!knownKeys.has(key)) {
        diagnostics.push(
          diagnostic({
            code: "recipes.unhandled_key",
            message: `Recipe '${input.id}' has unhandled key '${key}' for type '${input.type}'.`,
            details: { recipeId: input.id, type: input.type, key },
          }),
        );
      }
    }
  }

  if (input.raw.type === undefined) {
    diagnostics.push(
      diagnostic({
        code: "recipes.missing_type",
        message: `Recipe '${input.id}' is missing a type field.`,
        details: { recipeId: input.id },
      }),
    );
  }

  if (input.raw.result !== undefined && !input.result) {
    diagnostics.push(
      diagnostic({
        code: "recipes.invalid_result",
        message: `Recipe '${input.id}' has a result field that could not be parsed.`,
        details: { recipeId: input.id, type: input.type },
      }),
    );
  } else if (input.result && !input.result.id) {
    diagnostics.push(
      diagnostic({
        code: "recipes.result_missing_id",
        message: `Recipe '${input.id}' has a result object without an item id.`,
        details: { recipeId: input.id, type: input.type },
      }),
    );
  }

  for (const ingredient of input.ingredients) {
    if (ingredient.kind === "unknown") {
      diagnostics.push(
        diagnostic({
          code: "recipes.unknown_ingredient",
          message: `Recipe '${input.id}' has an ingredient shape that could not be normalized.`,
          details: { recipeId: input.id, type: input.type },
        }),
      );
    }
  }

  return diagnostics;
}

export function parseRecipeJson(input: {
  id: string;
  raw: JsonValue;
  filePath?: string | null;
}): ParsedRecipe {
  const raw = isObject(input.raw) ? input.raw : {};
  const [namespace, ...pathParts] = input.id.split(":");
  const type = normalizeIdentifier(stringValue(raw.type) ?? "unknown");
  const ingredients = collectIngredients(type, raw);
  const result = parseRecipeResult(raw.result);
  const recipe: ParsedRecipe = {
    id: input.id,
    namespace: namespace || "minecraft",
    path: pathParts.join(":"),
    filePath: input.filePath ?? null,
    type,
    group: stringValue(raw.group),
    category: stringValue(raw.category),
    showNotification: booleanValue(raw.show_notification),
    result,
    ingredients,
    raw,
    data: Object.fromEntries(
      Object.entries(raw).filter(
        ([key]) => !["type", "group", "category", "show_notification"].includes(key),
      ),
    ),
    diagnostics: [],
  };

  recipe.diagnostics = validateRecipeShape({
    id: recipe.id,
    type,
    raw,
    result,
    ingredients,
  });
  return recipe;
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

async function pathExists(directory: string): Promise<boolean> {
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

export async function loadRecipesFromRecipeDirectory(input: {
  recipeDirectory: string;
  namespace?: string;
}): Promise<RecipesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const files = (await collectJsonFiles(input.recipeDirectory)).sort();
  const recipes = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(input.recipeDirectory, filePath);
      const id = recipeIdFromFile(namespace, relativePath);
      return parseRecipeJson({
        id,
        raw: JSON.parse(await readFile(filePath, "utf8")) as JsonValue,
        filePath,
      });
    }),
  );

  const recipeTypeCounts: Record<string, number> = {};
  for (const recipe of recipes) {
    recipeTypeCounts[recipe.type] = (recipeTypeCounts[recipe.type] ?? 0) + 1;
  }

  return {
    recipes,
    recipeById: Object.fromEntries(recipes.map((recipe) => [recipe.id, recipe])),
    recipeTypeCounts,
    diagnostics: recipes.flatMap((recipe) => recipe.diagnostics),
  };
}

export async function loadRecipesFromDataRoot(input: {
  dataRoot: string;
  namespace?: string;
}): Promise<RecipesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const candidates = [
    path.join(input.dataRoot, "data", namespace, "recipe"),
    path.join(input.dataRoot, namespace, "recipe"),
    path.join(input.dataRoot, "recipe"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return loadRecipesFromRecipeDirectory({
        recipeDirectory: candidate,
        namespace,
      });
    }
  }

  return {
    recipes: [],
    recipeById: {},
    recipeTypeCounts: {},
    diagnostics: [
      diagnostic({
        code: "recipes.directory_missing",
        message: `Could not find recipe directory under '${input.dataRoot}'.`,
        details: { dataRoot: input.dataRoot, namespace },
      }),
    ],
  };
}
