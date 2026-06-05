import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import {
  parseBlocks,
  parseCreativeModeTabs,
  parseFoods,
  parseItems,
  parseVanillaBlockLoot,
} from "./src/parser";
import { loadJavaSources } from "./src/source-loader";
import type { BlockLootBehavior, ParsedFood, ParsedItem, VanillaBlockLootEntry } from "./src/types";
import { pathExists, runExec } from "./src/utils";

type ItemIndex = Record<string, Record<string, unknown>>;

type ModelFile = {
  parent?: string;
  textures?: Record<string, string | Record<string, unknown>>;
  elements?: unknown[];
};

type ModelFaceDef = {
  texture: string;
  uv: [number, number, number, number];
  rotation: 0 | 90 | 180 | 270;
  tintIndex: number | null;
};

type ModelElementRotation = {
  axis: "x" | "y" | "z";
  angle: number;
  origin: [number, number, number];
};

type ModelElementDef = {
  from: [number, number, number];
  to: [number, number, number];
  rotation: ModelElementRotation | null;
  faces: Partial<Record<"up" | "down" | "north" | "south" | "east" | "west", ModelFaceDef>>;
};

type ResolvedModelDefinition = {
  textureMap: Record<string, string>;
  elements: ModelElementDef[];
};

type Candidate = {
  kind: "model" | "texture";
  ref: string;
  tintDefs: unknown[] | null;
};

type OutputItem = {
  id: string;
  texturePath: string | null;
  sourceTexture: string | null;
  sourceModel: string | null;
  registration: ParsedItem["registration"] | null;
  maxStackSize: number | null;
  maxDamage: number | null;
  rarity: string | null;
  fireResistant: boolean | null;
  creativeTabs: string[];
  food: {
    id: string;
    nutrition: number | null;
    saturationModifier: number | null;
    alwaysEdible: boolean;
    effectCount: number;
  } | null;
  blockLoot: {
    behavior: BlockLootBehavior["behavior"];
    noLootTable: boolean;
    overrideLootSourceBlock: string | null;
    lootMethod: VanillaBlockLootEntry["lootMethod"] | null;
    lootDropField: string | null;
  } | null;
};

type ParsedPng = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compressionMethod: number;
  filterMethod: number;
  interlaceMethod: number;
  chunks: Array<{ type: string; data: Buffer }>;
  idatData: Buffer;
};

type RgbaImage = {
  width: number;
  height: number;
  data: Buffer;
};

type ModelRenderView = "front" | "back";

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

type AnimationMeta = {
  animation?: {
    width?: number;
    height?: number;
    frames?: Array<number | { index?: number }>;
  };
};

type SpecialTextureEntry = {
  absolutePath: string;
  filename: string;
};

function printUsage(): void {
  console.log(`Usage: npm run fetch:items -- [--game-version <version>]

Options:
  --game-version, --minecraft-version, --mc-version  Minecraft version to fetch.
  --help                                           Show this help text.

Examples:
  npm run fetch:items -- --game-version 1.21.8
  npm run fetch:items -- --game-version=1.21.8
`);
}

function applyCliOptions(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (
      arg === "--game-version" ||
      arg === "--minecraft-version" ||
      arg === "--mc-version"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a version value`);
      }
      process.env.ITEMFETCH_GAME_VERSION = value;
      index += 1;
      continue;
    }

    const inlineMatch = arg.match(/^--(?:game-version|minecraft-version|mc-version)=(.+)$/);
    if (inlineMatch) {
      process.env.ITEMFETCH_GAME_VERSION = inlineMatch[1];
      continue;
    }

    if (!arg.startsWith("-") && !process.env.ITEMFETCH_GAME_VERSION) {
      process.env.ITEMFETCH_GAME_VERSION = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }
}

try {
  applyCliOptions(process.argv.slice(2));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}

const LOCAL_ASSETS_ROOT_OVERRIDE = process.env.ITEMFETCH_ASSETS_LOCAL_DIR
  ? path.resolve(process.cwd(), process.env.ITEMFETCH_ASSETS_LOCAL_DIR)
  : null;
let activeAssetsRoot: string | null = LOCAL_ASSETS_ROOT_OVERRIDE;

const ITEM_INDEX_ASSET_PATH = "assets/minecraft/items/_all.json";
const ITEMS_DIRECTORY_ASSET_PATH = "assets/minecraft/items";
const SPECIAL_TEXTURE_ROOT = path.resolve(process.cwd(), "itemfetch/special");

const OUTPUT_ROOT = path.resolve(process.cwd(), "public/items");
const OUTPUT_TEXTURE_ROOT = path.join(OUTPUT_ROOT, "textures");
const OUTPUT_INDEX_PATH = path.join(OUTPUT_ROOT, "items.json");
const MODEL_RENDER_SIZE = Number(process.env.ITEMFETCH_MODEL_RENDER_SIZE ?? "64");
const MODEL_RENDER_SUPERSAMPLE = Math.max(
  1,
  Number(process.env.ITEMFETCH_MODEL_RENDER_SUPERSAMPLE ?? "2"),
);
const MODEL_RENDER_VIEW: ModelRenderView = "back";

const ITEM_LIMIT = Number(process.env.ITEMFETCH_LIMIT ?? "0");
const CONCURRENCY = Number(process.env.ITEMFETCH_CONCURRENCY ?? "24");

const PREFERRED_TEXTURE_KEYS = [
  "layer0",
  "layer1",
  "layer2",
  "all",
  "front",
  "top",
  "side",
  "back",
  "end",
  "bottom",
  "particle",
];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const modelCache = new Map<string, Promise<ModelFile | null>>();
const textureMapCache = new Map<string, Promise<Record<string, string>>>();
const textureBufferCache = new Map<string, Promise<Buffer | null>>();
const textureMetaCache = new Map<string, Promise<AnimationMeta | null>>();
const resolvedModelCache = new Map<string, Promise<ResolvedModelDefinition | null>>();
const textureRgbaCache = new Map<string, Promise<RgbaImage | null>>();
const renderedModelTextureCache = new Map<
  string,
  Promise<{ textureRef: string; bytes: Buffer } | null>
>();
let specialTextureMapPromise: Promise<Map<string, SpecialTextureEntry>> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSpecialTextureKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function loadSpecialTextureMap(): Promise<Map<string, SpecialTextureEntry>> {
  if (specialTextureMapPromise) {
    return specialTextureMapPromise;
  }

  specialTextureMapPromise = (async () => {
    const map = new Map<string, SpecialTextureEntry>();
    if (!(await pathExists(SPECIAL_TEXTURE_ROOT))) {
      return map;
    }

    const entries = await readdir(SPECIAL_TEXTURE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
        continue;
      }

      const filename = entry.name;
      const key = normalizeSpecialTextureKey(filename.slice(0, -".png".length));
      if (!key || map.has(key)) {
        continue;
      }

      map.set(key, {
        absolutePath: path.join(SPECIAL_TEXTURE_ROOT, filename),
        filename,
      });
    }

    return map;
  })();

  return specialTextureMapPromise;
}

function hasSpecialRenderer(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((value) => hasSpecialRenderer(value));
  }

  if (!isRecord(node)) {
    return false;
  }

  if (node.type === "minecraft:special") {
    return true;
  }

  for (const value of Object.values(node)) {
    if (hasSpecialRenderer(value)) {
      return true;
    }
  }

  return false;
}

async function resolveSpecialTextureForItem(
  itemId: string,
): Promise<{ textureRef: string; sourceModel: string | null; bytes: Buffer } | null> {
  const specialTextureMap = await loadSpecialTextureMap();
  const key = normalizeSpecialTextureKey(itemId);
  const specialTexture = specialTextureMap.get(key);
  if (!specialTexture) {
    return null;
  }

  return {
    textureRef: `special/${specialTexture.filename}`,
    sourceModel: "minecraft:special",
    bytes: await readFile(specialTexture.absolutePath),
  };
}

function parseNamespacedRef(
  ref: string,
  defaultNamespace = "minecraft",
): { namespace: string; assetPath: string } {
  const separatorIndex = ref.indexOf(":");
  if (separatorIndex === -1) {
    return {
      namespace: defaultNamespace,
      assetPath: ref.replace(/^\/+/, ""),
    };
  }

  return {
    namespace: ref.slice(0, separatorIndex),
    assetPath: ref.slice(separatorIndex + 1).replace(/^\/+/, ""),
  };
}

function modelRefToAssetPath(modelRef: string): string {
  const parsed = parseNamespacedRef(modelRef);
  return `assets/${parsed.namespace}/models/${parsed.assetPath}.json`;
}

function textureRefToAssetPath(textureRef: string): string {
  const parsed = parseNamespacedRef(textureRef);
  const withTextureDir = parsed.assetPath.startsWith("textures/")
    ? parsed.assetPath
    : `textures/${parsed.assetPath}`;
  const withExtension = withTextureDir.endsWith(".png")
    ? withTextureDir
    : `${withTextureDir}.png`;
  return `assets/${parsed.namespace}/${withExtension}`;
}

async function readTextAssetOptional(assetPath: string): Promise<string | null> {
  if (!activeAssetsRoot) {
    throw new Error("Asset root is not initialized");
  }

  const absolutePath = path.join(activeAssetsRoot, assetPath);
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
    }
    throw error;
  }
}

async function readBinaryAssetOptional(assetPath: string): Promise<Buffer | null> {
  if (!activeAssetsRoot) {
    throw new Error("Asset root is not initialized");
  }

  const absolutePath = path.join(activeAssetsRoot, assetPath);
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
    }
    throw error;
  }
}

async function readRequiredTextAsset(assetPath: string): Promise<string> {
  const text = await readTextAssetOptional(assetPath);
  if (text === null) {
    throw new Error(`Required asset is missing: ${assetPath}`);
  }
  return text;
}

function textureRefToMcmetaAssetPath(textureRef: string): string {
  return `${textureRefToAssetPath(textureRef)}.mcmeta`;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcBuffer = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function parsePng(bytes: Buffer): ParsedPng | null {
  if (bytes.length < PNG_SIGNATURE.length + 12) {
    return null;
  }

  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let width = -1;
  let height = -1;
  let bitDepth = -1;
  let colorType = -1;
  let compressionMethod = -1;
  let filterMethod = -1;
  let interlaceMethod = -1;

  const chunks: Array<{ type: string; data: Buffer }> = [];
  const idatParts: Buffer[] = [];

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;

    const type = bytes.toString("ascii", offset, offset + 4);
    offset += 4;

    if (offset + length + 4 > bytes.length) {
      return null;
    }

    const chunkData = bytes.subarray(offset, offset + length);
    offset += length;

    // CRC (read but not validated)
    offset += 4;

    chunks.push({ type, data: Buffer.from(chunkData) });

    if (type === "IHDR") {
      if (length !== 13) {
        return null;
      }
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData.readUInt8(8);
      colorType = chunkData.readUInt8(9);
      compressionMethod = chunkData.readUInt8(10);
      filterMethod = chunkData.readUInt8(11);
      interlaceMethod = chunkData.readUInt8(12);
    } else if (type === "IDAT") {
      idatParts.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
  }

  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth < 0 ||
    colorType < 0 ||
    compressionMethod < 0 ||
    filterMethod < 0 ||
    interlaceMethod < 0
  ) {
    return null;
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    compressionMethod,
    filterMethod,
    interlaceMethod,
    chunks,
    idatData: Buffer.concat(idatParts),
  };
}

function bitsPerPixelForPng(colorType: number, bitDepth: number): number | null {
  let channels = 0;
  switch (colorType) {
    case 0:
      channels = 1;
      break;
    case 2:
      channels = 3;
      break;
    case 3:
      channels = 1;
      break;
    case 4:
      channels = 2;
      break;
    case 6:
      channels = 4;
      break;
    default:
      return null;
  }
  return channels * bitDepth;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function decodePngScanlines(
  inflated: Buffer,
  rowByteLength: number,
  rowCount: number,
  bytesPerPixel: number,
): Buffer | null {
  const expectedLength = rowCount * (rowByteLength + 1);
  if (inflated.length !== expectedLength) {
    return null;
  }

  const decoded = Buffer.alloc(rowCount * rowByteLength);

  for (let row = 0; row < rowCount; row += 1) {
    const srcStart = row * (rowByteLength + 1);
    const filterType = inflated[srcStart];
    const srcRow = inflated.subarray(srcStart + 1, srcStart + 1 + rowByteLength);
    const dstStart = row * rowByteLength;

    switch (filterType) {
      case 0: {
        srcRow.copy(decoded, dstStart);
        break;
      }
      case 1: {
        for (let i = 0; i < rowByteLength; i += 1) {
          const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
          decoded[dstStart + i] = (srcRow[i] + left) & 0xff;
        }
        break;
      }
      case 2: {
        const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
        for (let i = 0; i < rowByteLength; i += 1) {
          const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
          decoded[dstStart + i] = (srcRow[i] + up) & 0xff;
        }
        break;
      }
      case 3: {
        const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
        for (let i = 0; i < rowByteLength; i += 1) {
          const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
          const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
          const avg = Math.floor((left + up) / 2);
          decoded[dstStart + i] = (srcRow[i] + avg) & 0xff;
        }
        break;
      }
      case 4: {
        const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
        for (let i = 0; i < rowByteLength; i += 1) {
          const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
          const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
          const upLeft =
            prevStart >= 0 && i >= bytesPerPixel
              ? decoded[prevStart + i - bytesPerPixel]
              : 0;
          const predictor = paethPredictor(left, up, upLeft);
          decoded[dstStart + i] = (srcRow[i] + predictor) & 0xff;
        }
        break;
      }
      default:
        return null;
    }
  }

  return decoded;
}

function encodePngRowsWithFilterNone(rows: Buffer, rowByteLength: number): Buffer {
  if (rowByteLength <= 0 || rows.length % rowByteLength !== 0) {
    return Buffer.alloc(0);
  }

  const rowCount = rows.length / rowByteLength;
  const encoded = Buffer.alloc(rowCount * (rowByteLength + 1));
  for (let row = 0; row < rowCount; row += 1) {
    const dstStart = row * (rowByteLength + 1);
    encoded[dstStart] = 0;
    rows.copy(
      encoded,
      dstStart + 1,
      row * rowByteLength,
      row * rowByteLength + rowByteLength,
    );
  }
  return encoded;
}

function buildPngWithUpdatedImageData(
  parsed: ParsedPng,
  newHeight: number,
  compressedIdat: Buffer,
): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(parsed.width, 0);
  ihdrData.writeUInt32BE(newHeight, 4);
  ihdrData.writeUInt8(parsed.bitDepth, 8);
  ihdrData.writeUInt8(parsed.colorType, 9);
  ihdrData.writeUInt8(parsed.compressionMethod, 10);
  ihdrData.writeUInt8(parsed.filterMethod, 11);
  ihdrData.writeUInt8(parsed.interlaceMethod, 12);

  const parts: Buffer[] = [PNG_SIGNATURE, encodePngChunk("IHDR", ihdrData)];

  let insertedIdat = false;
  for (const chunk of parsed.chunks) {
    if (chunk.type === "IHDR" || chunk.type === "IEND") {
      continue;
    }

    if (chunk.type === "IDAT") {
      if (!insertedIdat) {
        parts.push(encodePngChunk("IDAT", compressedIdat));
        insertedIdat = true;
      }
      continue;
    }

    parts.push(encodePngChunk(chunk.type, chunk.data));
  }

  if (!insertedIdat) {
    parts.push(encodePngChunk("IDAT", compressedIdat));
  }

  parts.push(encodePngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function parseModelFace(value: unknown): ModelFaceDef | null {
  if (!isRecord(value) || typeof value.texture !== "string") {
    return null;
  }

  const rotationRaw = value.rotation;
  const rotation =
    rotationRaw === 90 || rotationRaw === 180 || rotationRaw === 270 ? rotationRaw : 0;

  const uvRaw = value.uv;
  const tintIndexRaw = value.tintindex;
  const tintIndex =
    typeof tintIndexRaw === "number" &&
    Number.isFinite(tintIndexRaw) &&
    Number.isInteger(tintIndexRaw) &&
    tintIndexRaw >= 0
      ? tintIndexRaw
      : null;
  const uvDefault: [number, number, number, number] = [0, 0, 16, 16];
  if (!Array.isArray(uvRaw)) {
    return {
      texture: value.texture,
      uv: uvDefault,
      rotation,
      tintIndex,
    };
  }

  if (
    uvRaw.length !== 4 ||
    uvRaw.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return {
      texture: value.texture,
      uv: uvDefault,
      rotation,
      tintIndex,
    };
  }

  return {
    texture: value.texture,
    uv: [uvRaw[0], uvRaw[1], uvRaw[2], uvRaw[3]],
    rotation,
    tintIndex,
  };
}

function parseModelElementRotation(value: unknown): ModelElementRotation | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.axis !== "x" && value.axis !== "y" && value.axis !== "z") {
    return null;
  }
  if (typeof value.angle !== "number" || !Number.isFinite(value.angle)) {
    return null;
  }
  if (
    !Array.isArray(value.origin) ||
    value.origin.length !== 3 ||
    value.origin.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }

  return {
    axis: value.axis,
    angle: value.angle,
    origin: [value.origin[0], value.origin[1], value.origin[2]],
  };
}

function parseModelElements(value: unknown): ModelElementDef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const elements: ModelElementDef[] = [];
  for (const rawElement of value) {
    if (!isRecord(rawElement) || !Array.isArray(rawElement.from) || !Array.isArray(rawElement.to)) {
      continue;
    }

    if (
      rawElement.from.length !== 3 ||
      rawElement.to.length !== 3 ||
      rawElement.from.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)) ||
      rawElement.to.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      continue;
    }

    const faces: ModelElementDef["faces"] = {};
    if (isRecord(rawElement.faces)) {
      for (const faceName of ["up", "down", "north", "south", "east", "west"] as const) {
        const parsedFace = parseModelFace(rawElement.faces[faceName]);
        if (parsedFace) {
          faces[faceName] = parsedFace;
        }
      }
    }

    elements.push({
      from: [rawElement.from[0], rawElement.from[1], rawElement.from[2]],
      to: [rawElement.to[0], rawElement.to[1], rawElement.to[2]],
      rotation: parseModelElementRotation(rawElement.rotation),
      faces,
    });
  }

  return elements;
}

function decodePngToRgbaImage(bytes: Buffer): RgbaImage | null {
  const parsed = parsePng(bytes);
  if (!parsed) {
    return null;
  }

  if (
    parsed.compressionMethod !== 0 ||
    parsed.filterMethod !== 0 ||
    parsed.interlaceMethod !== 0
  ) {
    return null;
  }
  if (parsed.colorType !== 3 && parsed.bitDepth !== 8) {
    return null;
  }
  if (parsed.colorType === 3 && ![1, 2, 4, 8].includes(parsed.bitDepth)) {
    return null;
  }

  const bitsPerPixel = bitsPerPixelForPng(parsed.colorType, parsed.bitDepth);
  if (!bitsPerPixel) {
    return null;
  }

  const rowByteLength = Math.ceil((parsed.width * bitsPerPixel) / 8);
  const bytesPerPixelForFilter = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const inflated = inflateSync(parsed.idatData);
  const decodedRows = decodePngScanlines(
    inflated,
    rowByteLength,
    parsed.height,
    bytesPerPixelForFilter,
  );
  if (!decodedRows) {
    return null;
  }

  const rgba = Buffer.alloc(parsed.width * parsed.height * 4);
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  if (parsed.colorType === 3) {
    for (const chunk of parsed.chunks) {
      if (chunk.type === "PLTE") {
        palette = chunk.data;
      } else if (chunk.type === "tRNS") {
        transparency = chunk.data;
      }
    }
    if (!palette || palette.length % 3 !== 0) {
      return null;
    }
  }
  for (let y = 0; y < parsed.height; y += 1) {
    const rowOffset = y * rowByteLength;
    for (let x = 0; x < parsed.width; x += 1) {
      const srcOffset =
        rowOffset +
        x *
          (parsed.colorType === 6
            ? 4
            : parsed.colorType === 2
              ? 3
              : parsed.colorType === 0
                ? 1
                : parsed.colorType === 4
                  ? 2
                  : 0);
      const dstOffset = (y * parsed.width + x) * 4;

      if (parsed.colorType === 6) {
        rgba[dstOffset] = decodedRows[srcOffset];
        rgba[dstOffset + 1] = decodedRows[srcOffset + 1];
        rgba[dstOffset + 2] = decodedRows[srcOffset + 2];
        rgba[dstOffset + 3] = decodedRows[srcOffset + 3];
      } else if (parsed.colorType === 2) {
        rgba[dstOffset] = decodedRows[srcOffset];
        rgba[dstOffset + 1] = decodedRows[srcOffset + 1];
        rgba[dstOffset + 2] = decodedRows[srcOffset + 2];
        rgba[dstOffset + 3] = 255;
      } else if (parsed.colorType === 0) {
        const gray = decodedRows[srcOffset];
        rgba[dstOffset] = gray;
        rgba[dstOffset + 1] = gray;
        rgba[dstOffset + 2] = gray;
        rgba[dstOffset + 3] = 255;
      } else if (parsed.colorType === 4) {
        const gray = decodedRows[srcOffset];
        rgba[dstOffset] = gray;
        rgba[dstOffset + 1] = gray;
        rgba[dstOffset + 2] = gray;
        rgba[dstOffset + 3] = decodedRows[srcOffset + 1];
      } else if (parsed.colorType === 3) {
        if (!palette) {
          return null;
        }
        let index = 0;
        if (parsed.bitDepth === 8) {
          index = decodedRows[rowOffset + x];
        } else if (parsed.bitDepth === 4) {
          const packed = decodedRows[rowOffset + (x >> 1)];
          index = (x & 1) === 0 ? packed >> 4 : packed & 0x0f;
        } else if (parsed.bitDepth === 2) {
          const packed = decodedRows[rowOffset + (x >> 2)];
          const shift = 6 - (x & 0x3) * 2;
          index = (packed >> shift) & 0x03;
        } else {
          const packed = decodedRows[rowOffset + (x >> 3)];
          const shift = 7 - (x & 0x7);
          index = (packed >> shift) & 0x01;
        }
        const paletteOffset = index * 3;
        if (paletteOffset + 2 >= palette.length) {
          return null;
        }
        rgba[dstOffset] = palette[paletteOffset];
        rgba[dstOffset + 1] = palette[paletteOffset + 1];
        rgba[dstOffset + 2] = palette[paletteOffset + 2];
        rgba[dstOffset + 3] =
          transparency && index < transparency.length ? transparency[index] : 255;
      } else {
        return null;
      }
    }
  }

  return {
    width: parsed.width,
    height: parsed.height,
    data: rgba,
  };
}

function encodeRgbaImageToPng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  const rowByteLength = width * 4;
  const scanlines = Buffer.alloc((rowByteLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dstOffset = y * (rowByteLength + 1);
    scanlines[dstOffset] = 0;
    data.copy(scanlines, dstOffset + 1, y * rowByteLength, y * rowByteLength + rowByteLength);
  }

  const compressed = deflateSync(scanlines);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  return Buffer.concat([
    PNG_SIGNATURE,
    encodePngChunk("IHDR", ihdrData),
    encodePngChunk("IDAT", compressed),
    encodePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function downsampleRgbaImage(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): RgbaImage {
  if (source.width === targetWidth && source.height === targetHeight) {
    return source;
  }

  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const sy0 = Math.floor(ty * scaleY);
    const sy1 = Math.min(source.height, Math.floor((ty + 1) * scaleY));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sx0 = Math.floor(tx * scaleX);
      const sx1 = Math.min(source.width, Math.floor((tx + 1) * scaleX));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;

      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy += 1) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx += 1) {
          const srcOffset = (sy * source.width + sx) * 4;
          sumR += source.data[srcOffset];
          sumG += source.data[srcOffset + 1];
          sumB += source.data[srcOffset + 2];
          sumA += source.data[srcOffset + 3];
          count += 1;
        }
      }

      const dstOffset = (ty * targetWidth + tx) * 4;
      out[dstOffset] = Math.round(sumR / count);
      out[dstOffset + 1] = Math.round(sumG / count);
      out[dstOffset + 2] = Math.round(sumB / count);
      out[dstOffset + 3] = Math.round(sumA / count);
    }
  }

  return {
    width: targetWidth,
    height: targetHeight,
    data: out,
  };
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.trunc(value);
  return int > 0 ? int : null;
}

function getFirstAnimationFrameIndex(meta: AnimationMeta): number {
  const frames = meta.animation?.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return 0;
  }

  const firstFrame = frames[0];
  if (typeof firstFrame === "number" && Number.isFinite(firstFrame)) {
    return Math.max(0, Math.trunc(firstFrame));
  }

  if (isRecord(firstFrame)) {
    const index = firstFrame.index;
    if (typeof index === "number" && Number.isFinite(index)) {
      return Math.max(0, Math.trunc(index));
    }
  }

  return 0;
}

function cropAnimatedPngToSingleFrame(
  textureBytes: Buffer,
  animationMeta: AnimationMeta,
): Buffer {
  const parsed = parsePng(textureBytes);
  if (!parsed || !animationMeta.animation) {
    return textureBytes;
  }

  if (
    parsed.compressionMethod !== 0 ||
    parsed.filterMethod !== 0 ||
    parsed.interlaceMethod !== 0
  ) {
    return textureBytes;
  }

  const frameWidth = toPositiveInteger(animationMeta.animation.width) ?? parsed.width;
  const frameHeight =
    toPositiveInteger(animationMeta.animation.height) ??
    toPositiveInteger(animationMeta.animation.width) ??
    parsed.width;

  // Keep complex atlas layouts untouched; this handles the common vertical strip case.
  if (frameWidth !== parsed.width) {
    return textureBytes;
  }
  if (frameHeight <= 0 || frameHeight >= parsed.height) {
    return textureBytes;
  }

  const frameCount = Math.floor(parsed.height / frameHeight);
  if (frameCount <= 1) {
    return textureBytes;
  }

  const firstFrameIndex = Math.min(getFirstAnimationFrameIndex(animationMeta), frameCount - 1);
  const firstFrameRow = firstFrameIndex * frameHeight;

  const bitsPerPixel = bitsPerPixelForPng(parsed.colorType, parsed.bitDepth);
  if (!bitsPerPixel) {
    return textureBytes;
  }

  const rowByteLength = Math.ceil((parsed.width * bitsPerPixel) / 8);
  const bytesPerPixelForFilter = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const inflated = inflateSync(parsed.idatData);
  const decodedRows = decodePngScanlines(
    inflated,
    rowByteLength,
    parsed.height,
    bytesPerPixelForFilter,
  );
  if (!decodedRows) {
    return textureBytes;
  }

  const frameRows = Buffer.alloc(rowByteLength * frameHeight);
  for (let row = 0; row < frameHeight; row += 1) {
    const sourceOffset = (firstFrameRow + row) * rowByteLength;
    const destinationOffset = row * rowByteLength;
    decodedRows.copy(frameRows, destinationOffset, sourceOffset, sourceOffset + rowByteLength);
  }

  const encodedFrameRows = encodePngRowsWithFilterNone(frameRows, rowByteLength);
  const compressedFrameRows = deflateSync(encodedFrameRows);

  return buildPngWithUpdatedImageData(parsed, frameHeight, compressedFrameRows);
}

async function loadTextureAnimationMeta(textureRef: string): Promise<AnimationMeta | null> {
  const cached = textureMetaCache.get(textureRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const raw = await readTextAssetOptional(textureRefToMcmetaAssetPath(textureRef));
    if (raw === null) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      return parsed as AnimationMeta;
    } catch {
      return null;
    }
  })();

  textureMetaCache.set(textureRef, promise);
  return promise;
}

async function normalizeTextureBytes(textureRef: string, textureBytes: Buffer): Promise<Buffer> {
  const meta = await loadTextureAnimationMeta(textureRef);
  if (!meta?.animation) {
    return textureBytes;
  }

  try {
    return cropAnimatedPngToSingleFrame(textureBytes, meta);
  } catch {
    return textureBytes;
  }
}

async function fetchItemIndex(): Promise<ItemIndex> {
  const aggregatedRaw = await readTextAssetOptional(ITEM_INDEX_ASSET_PATH);
  if (aggregatedRaw !== null) {
    const parsed: unknown = JSON.parse(aggregatedRaw);
    if (!isRecord(parsed)) {
      throw new Error("Item index did not decode to an object");
    }
    return parsed as ItemIndex;
  }

  if (!activeAssetsRoot) {
    throw new Error("Asset root is not initialized");
  }

  const itemsDirectoryPath = path.join(activeAssetsRoot, ITEMS_DIRECTORY_ASSET_PATH);
  const entries = await readdir(itemsDirectoryPath, { withFileTypes: true });

  const itemIndex: ItemIndex = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const itemId = entry.name.slice(0, -".json".length);
    const jsonPath = path.join(ITEMS_DIRECTORY_ASSET_PATH, entry.name);
    const raw = await readRequiredTextAsset(jsonPath);
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      continue;
    }
    itemIndex[itemId] = parsed;
  }

  if (Object.keys(itemIndex).length === 0) {
    throw new Error(`No item definitions were found in ${itemsDirectoryPath}`);
  }

  return itemIndex;
}

function collectCandidates(
  node: unknown,
  out: Candidate[],
  inheritedTintDefs: unknown[] | null = null,
): void {
  if (Array.isArray(node)) {
    for (const value of node) {
      collectCandidates(value, out, inheritedTintDefs);
    }
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  const localTintDefs = Array.isArray(node.tints) ? node.tints : inheritedTintDefs;
  const typeValue = typeof node.type === "string" ? node.type : null;
  if (typeValue === "minecraft:model" && typeof node.model === "string") {
    out.push({ kind: "model", ref: node.model, tintDefs: localTintDefs });
  }
  if (typeValue === "minecraft:special" && typeof node.base === "string") {
    out.push({ kind: "model", ref: node.base, tintDefs: localTintDefs });
  }
  if (typeof node.texture === "string") {
    out.push({ kind: "texture", ref: node.texture, tintDefs: localTintDefs });
  }

  const preferredKeyOrder = [
    "fallback",
    "on_false",
    "model",
    "on_true",
    "cases",
    "entries",
    "models",
  ];
  const traversedKeys = new Set<string>();

  for (const key of preferredKeyOrder) {
    if (key in node) {
      traversedKeys.add(key);
      collectCandidates(node[key], out, localTintDefs);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (traversedKeys.has(key) || key === "type" || key === "texture") {
      continue;
    }
    collectCandidates(value, out, localTintDefs);
  }
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const deduped: Candidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const tintSignature = candidate.tintDefs ? JSON.stringify(candidate.tintDefs) : "";
    const signature = `${candidate.kind}:${candidate.ref}:${tintSignature}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(candidate);
  }

  return deduped;
}

async function loadModel(modelRef: string): Promise<ModelFile | null> {
  const cached = modelCache.get(modelRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const raw = await readTextAssetOptional(modelRefToAssetPath(modelRef));
    if (raw === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    return parsed as ModelFile;
  })();

  modelCache.set(modelRef, promise);
  return promise;
}

async function loadMergedTextureMap(
  modelRef: string,
  stack = new Set<string>(),
): Promise<Record<string, string>> {
  if (stack.has(modelRef)) {
    return {};
  }

  const cached = textureMapCache.get(modelRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const nextStack = new Set(stack);
    nextStack.add(modelRef);

    const model = await loadModel(modelRef);
    if (!model) {
      return {};
    }

    let inheritedTextures: Record<string, string> = {};
    if (typeof model.parent === "string") {
      inheritedTextures = await loadMergedTextureMap(model.parent, nextStack);
    }

    const ownTextures: Record<string, string> = {};
    if (isRecord(model.textures)) {
      for (const [key, value] of Object.entries(model.textures)) {
        if (typeof value === "string") {
          ownTextures[key] = value;
        } else if (isRecord(value) && typeof value.sprite === "string") {
          ownTextures[key] = value.sprite;
        }
      }
    }

    return { ...inheritedTextures, ...ownTextures };
  })();

  textureMapCache.set(modelRef, promise);
  return promise;
}

async function loadResolvedModelDefinition(
  modelRef: string,
  stack = new Set<string>(),
): Promise<ResolvedModelDefinition | null> {
  if (stack.has(modelRef)) {
    return null;
  }

  const cached = resolvedModelCache.get(modelRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const nextStack = new Set(stack);
    nextStack.add(modelRef);

    const model = await loadModel(modelRef);
    if (!model) {
      return null;
    }

    const inherited = typeof model.parent === "string"
      ? await loadResolvedModelDefinition(model.parent, nextStack)
      : null;

    const ownTextures: Record<string, string> = {};
    if (isRecord(model.textures)) {
      for (const [key, value] of Object.entries(model.textures)) {
        if (typeof value === "string") {
          ownTextures[key] = value;
        } else if (isRecord(value) && typeof value.sprite === "string") {
          ownTextures[key] = value.sprite;
        }
      }
    }

    const ownElements = parseModelElements(model.elements);
    return {
      textureMap: {
        ...(inherited?.textureMap ?? {}),
        ...ownTextures,
      },
      elements: ownElements.length > 0 ? ownElements : (inherited?.elements ?? []),
    };
  })();

  resolvedModelCache.set(modelRef, promise);
  return promise;
}

function resolveTextureAlias(
  textureMap: Record<string, string>,
  rawTextureValue: string,
): string | null {
  let current = rawTextureValue;
  const visitedKeys = new Set<string>();

  while (current.startsWith("#")) {
    const key = current.slice(1);
    if (visitedKeys.has(key)) {
      return null;
    }
    visitedKeys.add(key);

    const nextValue = textureMap[key];
    if (typeof nextValue !== "string") {
      return null;
    }
    current = nextValue;
  }

  return current;
}

function pickTextureFromMap(textureMap: Record<string, string>): string | null {
  for (const key of PREFERRED_TEXTURE_KEYS) {
    const value = textureMap[key];
    if (typeof value !== "string") {
      continue;
    }

    const resolved = resolveTextureAlias(textureMap, value);
    if (resolved) {
      return resolved;
    }
  }

  for (const value of Object.values(textureMap)) {
    if (typeof value !== "string") {
      continue;
    }

    const resolved = resolveTextureAlias(textureMap, value);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveTextureFromModel(modelRef: string): Promise<string | null> {
  const textureMap = await loadMergedTextureMap(modelRef);
  return pickTextureFromMap(textureMap);
}

async function readTextureBuffer(textureRef: string): Promise<Buffer | null> {
  const cached = textureBufferCache.get(textureRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const rawBytes = await readBinaryAssetOptional(textureRefToAssetPath(textureRef));
    if (!rawBytes) {
      return null;
    }
    return normalizeTextureBytes(textureRef, rawBytes);
  })();
  textureBufferCache.set(textureRef, promise);
  return promise;
}

async function readTextureRgba(textureRef: string): Promise<RgbaImage | null> {
  const cached = textureRgbaCache.get(textureRef);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const bytes = await readTextureBuffer(textureRef);
    if (!bytes) {
      return null;
    }
    return decodePngToRgbaImage(bytes);
  })();

  textureRgbaCache.set(textureRef, promise);
  return promise;
}

function intColorToRgb(value: number): RgbColor {
  const unsigned = value >>> 0;
  return {
    r: (unsigned >> 16) & 0xff,
    g: (unsigned >> 8) & 0xff,
    b: unsigned & 0xff,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function sampleColorFromColormap(
  textureRef: string,
  temperature: number,
  downfall: number,
  fallbackColor: number,
): Promise<number> {
  const image = await readTextureRgba(textureRef);
  if (!image || image.width <= 0 || image.height <= 0) {
    return fallbackColor;
  }

  const t = clamp01(temperature);
  const d = clamp01(downfall) * t;
  const x = Math.max(0, Math.min(image.width - 1, Math.floor((1 - t) * (image.width - 1))));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor((1 - d) * (image.height - 1))));
  const offset = (y * image.width + x) * 4;
  return (
    ((image.data[offset] & 0xff) << 16) |
    ((image.data[offset + 1] & 0xff) << 8) |
    (image.data[offset + 2] & 0xff)
  );
}

async function resolveTintColorFromDefinition(tintDef: unknown): Promise<number | null> {
  if (!isRecord(tintDef) || typeof tintDef.type !== "string") {
    return null;
  }

  if (tintDef.type === "minecraft:constant" && typeof tintDef.value === "number") {
    return tintDef.value;
  }

  if (tintDef.type === "minecraft:grass") {
    const temperature =
      typeof tintDef.temperature === "number" && Number.isFinite(tintDef.temperature)
        ? tintDef.temperature
        : 0.5;
    const downfall =
      typeof tintDef.downfall === "number" && Number.isFinite(tintDef.downfall)
        ? tintDef.downfall
        : 1.0;
    return sampleColorFromColormap("minecraft:colormap/grass", temperature, downfall, 0x7fb238);
  }

  if (tintDef.type === "minecraft:foliage") {
    const temperature =
      typeof tintDef.temperature === "number" && Number.isFinite(tintDef.temperature)
        ? tintDef.temperature
        : 0.5;
    const downfall =
      typeof tintDef.downfall === "number" && Number.isFinite(tintDef.downfall)
        ? tintDef.downfall
        : 1.0;
    return sampleColorFromColormap(
      "minecraft:colormap/foliage",
      temperature,
      downfall,
      0x48b518,
    );
  }

  return null;
}

async function resolveTintPalette(tintDefs: unknown[] | null): Promise<Array<RgbColor | null>> {
  if (!tintDefs || tintDefs.length === 0) {
    return [];
  }

  const colors = await Promise.all(tintDefs.map((def) => resolveTintColorFromDefinition(def)));
  return colors.map((color) => (color === null ? null : intColorToRgb(color)));
}

function applyTintToImage(image: RgbaImage, tintColor: RgbColor): RgbaImage {
  const out = Buffer.from(image.data);
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3];
    if (alpha === 0) {
      continue;
    }
    out[i] = Math.round((out[i] * tintColor.r) / 255);
    out[i + 1] = Math.round((out[i + 1] * tintColor.g) / 255);
    out[i + 2] = Math.round((out[i + 2] * tintColor.b) / 255);
  }
  return {
    width: image.width,
    height: image.height,
    data: out,
  };
}

function projectModelPoint(x: number, y: number, z: number): { x: number; y: number } {
  return {
    x: x - z,
    y: (x + z) * 0.5 - y * 1.15,
  };
}

function projectModelPointForView(
  x: number,
  y: number,
  z: number,
  view: ModelRenderView,
): { x: number; y: number } {
  if (view === "back") {
    return projectModelPoint(16 - x, y, 16 - z);
  }
  return projectModelPoint(x, y, z);
}

function getFullBlockProjectionBounds(): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const points = [
    projectModelPointForView(0, 0, 0, MODEL_RENDER_VIEW),
    projectModelPointForView(16, 0, 0, MODEL_RENDER_VIEW),
    projectModelPointForView(0, 0, 16, MODEL_RENDER_VIEW),
    projectModelPointForView(16, 0, 16, MODEL_RENDER_VIEW),
    projectModelPointForView(0, 16, 0, MODEL_RENDER_VIEW),
    projectModelPointForView(16, 16, 0, MODEL_RENDER_VIEW),
    projectModelPointForView(0, 16, 16, MODEL_RENDER_VIEW),
    projectModelPointForView(16, 16, 16, MODEL_RENDER_VIEW),
  ];

  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function alphaBlendPixel(
  target: Buffer,
  offset: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const srcA = a / 255;
  if (srcA <= 0) {
    return;
  }

  const dstA = target[offset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    return;
  }

  const outR = (r * srcA + target[offset] * dstA * (1 - srcA)) / outA;
  const outG = (g * srcA + target[offset + 1] * dstA * (1 - srcA)) / outA;
  const outB = (b * srcA + target[offset + 2] * dstA * (1 - srcA)) / outA;

  target[offset] = Math.max(0, Math.min(255, Math.round(outR)));
  target[offset + 1] = Math.max(0, Math.min(255, Math.round(outG)));
  target[offset + 2] = Math.max(0, Math.min(255, Math.round(outB)));
  target[offset + 3] = Math.max(0, Math.min(255, Math.round(outA * 255)));
}

type Vec3 = { x: number; y: number; z: number };

function rotateVectorAroundAxis(
  vector: Vec3,
  axis: "x" | "y" | "z",
  radians: number,
): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  if (axis === "x") {
    return {
      x: vector.x,
      y: vector.y * c - vector.z * s,
      z: vector.y * s + vector.z * c,
    };
  }
  if (axis === "y") {
    return {
      x: vector.x * c + vector.z * s,
      y: vector.y,
      z: -vector.x * s + vector.z * c,
    };
  }
  return {
    x: vector.x * c - vector.y * s,
    y: vector.x * s + vector.y * c,
    z: vector.z,
  };
}

function rotatePointAroundElementRotation(
  point: Vec3,
  rotation: ModelElementRotation | null,
): Vec3 {
  if (!rotation || rotation.angle === 0) {
    return point;
  }
  const radians = (rotation.angle * Math.PI) / 180;
  const translated = {
    x: point.x - rotation.origin[0],
    y: point.y - rotation.origin[1],
    z: point.z - rotation.origin[2],
  };
  const rotated = rotateVectorAroundAxis(translated, rotation.axis, radians);
  return {
    x: rotated.x + rotation.origin[0],
    y: rotated.y + rotation.origin[1],
    z: rotated.z + rotation.origin[2],
  };
}

function normalizeVec3(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length <= 1e-8) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function getFaceGeometry(
  faceName: "up" | "down" | "north" | "south" | "east" | "west",
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): { points: Vec3[]; normal: Vec3 } {
  switch (faceName) {
    case "up":
      return {
        points: [
          { x: x1, y: y2, z: z1 },
          { x: x2, y: y2, z: z1 },
          { x: x2, y: y2, z: z2 },
          { x: x1, y: y2, z: z2 },
        ],
        normal: { x: 0, y: 1, z: 0 },
      };
    case "down":
      return {
        points: [
          { x: x1, y: y1, z: z2 },
          { x: x2, y: y1, z: z2 },
          { x: x2, y: y1, z: z1 },
          { x: x1, y: y1, z: z1 },
        ],
        normal: { x: 0, y: -1, z: 0 },
      };
    case "north":
      return {
        points: [
          { x: x2, y: y2, z: z1 },
          { x: x1, y: y2, z: z1 },
          { x: x1, y: y1, z: z1 },
          { x: x2, y: y1, z: z1 },
        ],
        normal: { x: 0, y: 0, z: -1 },
      };
    case "south":
      return {
        points: [
          { x: x1, y: y2, z: z2 },
          { x: x2, y: y2, z: z2 },
          { x: x2, y: y1, z: z2 },
          { x: x1, y: y1, z: z2 },
        ],
        normal: { x: 0, y: 0, z: 1 },
      };
    case "east":
      return {
        points: [
          { x: x2, y: y2, z: z1 },
          { x: x2, y: y2, z: z2 },
          { x: x2, y: y1, z: z2 },
          { x: x2, y: y1, z: z1 },
        ],
        normal: { x: 1, y: 0, z: 0 },
      };
    default:
      return {
        points: [
          { x: x1, y: y2, z: z2 },
          { x: x1, y: y2, z: z1 },
          { x: x1, y: y1, z: z1 },
          { x: x1, y: y1, z: z2 },
        ],
        normal: { x: -1, y: 0, z: 0 },
      };
  }
}

function rotateUvCorners(
  corners: Array<{ u: number; v: number }>,
  rotation: 0 | 90 | 180 | 270,
): Array<{ u: number; v: number }> {
  let rotated = corners;
  const steps = rotation / 90;
  for (let i = 0; i < steps; i += 1) {
    rotated = [rotated[3], rotated[0], rotated[1], rotated[2]];
  }
  return rotated;
}

type ScreenVertex = {
  x: number;
  y: number;
  u: number;
  v: number;
};

function sampleTextureRgbaWithAlphaBleed(
  texture: RgbaImage,
  u: number,
  v: number,
): { r: number; g: number; b: number; a: number } {
  const tx = Math.max(
    0,
    Math.min(texture.width - 1, Math.floor((u / 16) * texture.width)),
  );
  const ty = Math.max(
    0,
    Math.min(texture.height - 1, Math.floor((v / 16) * texture.height)),
  );

  const offset = (ty * texture.width + tx) * 4;
  let r = texture.data[offset];
  let g = texture.data[offset + 1];
  let b = texture.data[offset + 2];
  let a = texture.data[offset + 3];
  if (a > 0) {
    return { r, g, b, a };
  }

  // Avoid thin transparent seams from UV edge sampling by borrowing nearest opaque texel.
  for (let radius = 1; radius <= 2; radius += 1) {
    let bestOffset = -1;
    let bestAlpha = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= texture.width || ny >= texture.height) {
          continue;
        }
        const candidateOffset = (ny * texture.width + nx) * 4;
        const candidateAlpha = texture.data[candidateOffset + 3];
        if (candidateAlpha > bestAlpha) {
          bestAlpha = candidateAlpha;
          bestOffset = candidateOffset;
        }
      }
    }
    if (bestOffset !== -1 && bestAlpha > 0) {
      r = texture.data[bestOffset];
      g = texture.data[bestOffset + 1];
      b = texture.data[bestOffset + 2];
      a = texture.data[bestOffset + 3];
      return { r, g, b, a };
    }
  }

  return { r, g, b, a };
}

function drawTexturedTriangle(
  target: RgbaImage,
  texture: RgbaImage,
  v0: ScreenVertex,
  v1: ScreenVertex,
  v2: ScreenVertex,
  tintColor: RgbColor | null,
): void {
  const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x)) - 1);
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x)) + 1);
  const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y)) - 1);
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y)) + 1);

  const denom =
    (v1.y - v2.y) * (v0.x - v2.x) +
    (v2.x - v1.x) * (v0.y - v2.y);
  if (Math.abs(denom) < 1e-6) {
    return;
  }
  const edgeEpsilon = 0.002;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const sx = px + 0.5;
      const sy = py + 0.5;

      const w0 =
        ((v1.y - v2.y) * (sx - v2.x) + (v2.x - v1.x) * (sy - v2.y)) / denom;
      const w1 =
        ((v2.y - v0.y) * (sx - v2.x) + (v0.x - v2.x) * (sy - v2.y)) / denom;
      const w2 = 1 - w0 - w1;

      if (w0 < -edgeEpsilon || w1 < -edgeEpsilon || w2 < -edgeEpsilon) {
        continue;
      }

      const u = w0 * v0.u + w1 * v1.u + w2 * v2.u;
      const v = w0 * v0.v + w1 * v1.v + w2 * v2.v;
      const sampled = sampleTextureRgbaWithAlphaBleed(texture, u, v);
      const alpha = sampled.a;
      if (alpha === 0) {
        continue;
      }
      const tintedR = tintColor ? Math.round((sampled.r * tintColor.r) / 255) : sampled.r;
      const tintedG = tintColor ? Math.round((sampled.g * tintColor.g) / 255) : sampled.g;
      const tintedB = tintColor ? Math.round((sampled.b * tintColor.b) / 255) : sampled.b;

      const dstOffset = (py * target.width + px) * 4;
      alphaBlendPixel(
        target.data,
        dstOffset,
        tintedR,
        tintedG,
        tintedB,
        alpha,
      );
    }
  }
}

async function renderTextureFromModel(
  modelRef: string,
  tintPalette: Array<RgbColor | null>,
): Promise<{ textureRef: string; bytes: Buffer } | null> {
  const renderKey = `${modelRef}|${
    tintPalette.map((color) => (color ? `${color.r},${color.g},${color.b}` : "null")).join(";")
  }`;
  const cached = renderedModelTextureCache.get(renderKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const resolved = await loadResolvedModelDefinition(modelRef);
    if (!resolved || resolved.elements.length === 0) {
      return null;
    }

    const facesToRender: Array<{
      points: Array<{ x: number; y: number; z: number }>;
      uvCorners: Array<{ u: number; v: number }>;
      textureRef: string;
      depth: number;
      tintColor: RgbColor | null;
    }> = [];
    const viewDirection = normalizeVec3(
      MODEL_RENDER_VIEW === "back"
        ? { x: -1, y: 1, z: -1 }
        : { x: 1, y: 1, z: 1 },
    );

    for (const element of resolved.elements) {
      const x1 = element.from[0];
      const y1 = element.from[1];
      const z1 = element.from[2];
      const x2 = element.to[0];
      const y2 = element.to[1];
      const z2 = element.to[2];
      for (const faceName of ["up", "down", "north", "south", "east", "west"] as const) {
        const face = element.faces[faceName];
        if (!face) {
          continue;
        }
        const textureRef = resolveTextureAlias(resolved.textureMap, face.texture);
        if (!textureRef) {
          continue;
        }

        const geometry = getFaceGeometry(faceName, x1, y1, z1, x2, y2, z2);
        const rotatedPoints = geometry.points.map((point) =>
          rotatePointAroundElementRotation(point, element.rotation),
        );
        const rotatedNormal = normalizeVec3(
          rotateVectorAroundAxis(
            geometry.normal,
            element.rotation?.axis ?? "x",
            element.rotation ? (element.rotation.angle * Math.PI) / 180 : 0,
          ),
        );
        const facing = rotatedNormal.x * viewDirection.x +
          rotatedNormal.y * viewDirection.y +
          rotatedNormal.z * viewDirection.z;
        if (facing <= 1e-4) {
          continue;
        }

        const [u1, v1, u2, v2] = face.uv;
        const uvCorners = rotateUvCorners(
          [
            { u: u1, v: v1 },
            { u: u2, v: v1 },
            { u: u2, v: v2 },
            { u: u1, v: v2 },
          ],
          face.rotation,
        );

        const centroid = rotatedPoints.reduce(
          (sum, point) => ({
            x: sum.x + point.x,
            y: sum.y + point.y,
            z: sum.z + point.z,
          }),
          { x: 0, y: 0, z: 0 },
        );
        centroid.x /= rotatedPoints.length;
        centroid.y /= rotatedPoints.length;
        centroid.z /= rotatedPoints.length;

        // Painter depth in camera-aligned axis; smaller is farther, larger is nearer.
        const depth =
          centroid.x * viewDirection.x +
          centroid.y * viewDirection.y +
          centroid.z * viewDirection.z;

        facesToRender.push({
          points: rotatedPoints,
          uvCorners,
          textureRef,
          depth,
          tintColor: face.tintIndex === null ? null : (tintPalette[face.tintIndex] ?? null),
        });
      }
    }

    if (facesToRender.length === 0) {
      return null;
    }

    const projected = facesToRender.map((face) => ({
      ...face,
      projectedPoints: face.points.map((point) =>
        projectModelPointForView(point.x, point.y, point.z, MODEL_RENDER_VIEW),
      ),
    }));

    const { minX, maxX, minY, maxY } = getFullBlockProjectionBounds();
    const outputSize = Math.max(16, MODEL_RENDER_SIZE);
    const supersampledSize = outputSize * MODEL_RENDER_SUPERSAMPLE;
    const padding = MODEL_RENDER_SUPERSAMPLE;
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    const scale = Math.min(
      (supersampledSize - padding * 2) / spanX,
      (supersampledSize - padding * 2) / spanY,
    );

    const output: RgbaImage = {
      width: supersampledSize,
      height: supersampledSize,
      data: Buffer.alloc(supersampledSize * supersampledSize * 4),
    };

    projected.sort((a, b) => a.depth - b.depth);
    for (const face of projected) {
      const texture = await readTextureRgba(face.textureRef);
      if (!texture) {
        continue;
      }

      const mapped = face.projectedPoints.map((point) => ({
        x: (point.x - minX) * scale + padding,
        y: (point.y - minY) * scale + padding,
      }));

      const vertices: ScreenVertex[] = [
        { ...mapped[0], u: face.uvCorners[0].u, v: face.uvCorners[0].v },
        { ...mapped[1], u: face.uvCorners[1].u, v: face.uvCorners[1].v },
        { ...mapped[2], u: face.uvCorners[2].u, v: face.uvCorners[2].v },
        { ...mapped[3], u: face.uvCorners[3].u, v: face.uvCorners[3].v },
      ];

      drawTexturedTriangle(
        output,
        texture,
        vertices[0],
        vertices[1],
        vertices[2],
        face.tintColor,
      );
      drawTexturedTriangle(
        output,
        texture,
        vertices[0],
        vertices[2],
        vertices[3],
        face.tintColor,
      );
    }

    let hasOpaquePixel = false;
    for (let i = 3; i < output.data.length; i += 4) {
      if (output.data[i] > 0) {
        hasOpaquePixel = true;
        break;
      }
    }
    if (!hasOpaquePixel) {
      return null;
    }

    const finalImage =
      MODEL_RENDER_SUPERSAMPLE > 1
        ? downsampleRgbaImage(output, outputSize, outputSize)
        : output;

    const sourceTexture = projected[0].textureRef;
    return {
      textureRef: sourceTexture,
      bytes: encodeRgbaImageToPng(finalImage),
    };
  })();

  renderedModelTextureCache.set(renderKey, promise);
  return promise;
}

async function resolveItemTexture(
  itemId: string,
  itemDefinition: Record<string, unknown>,
): Promise<{ textureRef: string; sourceModel: string | null; bytes: Buffer } | null> {
  if (hasSpecialRenderer(itemDefinition.model)) {
    const specialTexture = await resolveSpecialTextureForItem(itemId);
    if (specialTexture) {
      return specialTexture;
    }
  }

  const rawCandidates: Candidate[] = [];
  collectCandidates(itemDefinition.model, rawCandidates);
  const candidates = dedupeCandidates(rawCandidates);

  for (const candidate of candidates) {
    const tintPalette = await resolveTintPalette(candidate.tintDefs);
    const primaryTint = tintPalette[0] ?? null;

    if (candidate.kind === "texture") {
      const bytes = await readTextureBuffer(candidate.ref);
      if (bytes) {
        if (!primaryTint) {
          return { textureRef: candidate.ref, sourceModel: null, bytes };
        }
        const textureImage = decodePngToRgbaImage(bytes);
        if (!textureImage) {
          return { textureRef: candidate.ref, sourceModel: null, bytes };
        }
        return {
          textureRef: candidate.ref,
          sourceModel: null,
          bytes: encodeRgbaImageToPng(applyTintToImage(textureImage, primaryTint)),
        };
      }
      continue;
    }

    const rendered = await renderTextureFromModel(candidate.ref, tintPalette);
    if (rendered) {
      return {
        textureRef: rendered.textureRef,
        sourceModel: candidate.ref,
        bytes: rendered.bytes,
      };
    }

    const resolvedTexture = await resolveTextureFromModel(candidate.ref);
    if (!resolvedTexture) {
      continue;
    }

    const bytes = await readTextureBuffer(resolvedTexture);
    if (bytes) {
      if (!primaryTint) {
        return {
          textureRef: resolvedTexture,
          sourceModel: candidate.ref,
          bytes,
        };
      }
      const textureImage = decodePngToRgbaImage(bytes);
      if (!textureImage) {
        return {
          textureRef: resolvedTexture,
          sourceModel: candidate.ref,
          bytes,
        };
      }
      return {
        textureRef: resolvedTexture,
        sourceModel: candidate.ref,
        bytes: encodeRgbaImageToPng(applyTintToImage(textureImage, primaryTint)),
      };
    }
  }

  const fallbackTextureRef = `minecraft:item/${itemId}`;
  const fallbackBytes = await readTextureBuffer(fallbackTextureRef);
  if (fallbackBytes) {
    return {
      textureRef: fallbackTextureRef,
      sourceModel: null,
      bytes: fallbackBytes,
    };
  }

  return null;
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (values.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, values.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= values.length) {
          return;
        }

        await worker(values[index], index);
      }
    }),
  );
}

async function ensureAssetsExtractedFromJar(
  jarPath: string,
  cacheVersionRoot: string,
): Promise<string> {
  const assetsRoot = path.join(cacheVersionRoot, "assets-extracted");
  const extractedItemsDirectoryPath = path.join(assetsRoot, ITEMS_DIRECTORY_ASSET_PATH);

  if (await pathExists(extractedItemsDirectoryPath)) {
    return assetsRoot;
  }

  await mkdir(assetsRoot, { recursive: true });
  console.log(`Extracting assets/ from ${jarPath}...`);
  await runExec("jar", ["xf", jarPath, "assets"], {
    cwd: assetsRoot,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (!(await pathExists(extractedItemsDirectoryPath))) {
    throw new Error(
      `Assets were extracted, but ${ITEMS_DIRECTORY_ASSET_PATH} was not found in ${assetsRoot}`,
    );
  }

  return assetsRoot;
}

function toOutputItem(
  itemId: string,
  texture: { texturePath: string | null; sourceTexture: string | null; sourceModel: string | null },
  parsedItem: ParsedItem | null,
  parsedFood: ParsedFood | null,
  creativeTabs: string[],
  vanillaBlockLootEntry: VanillaBlockLootEntry | null,
): OutputItem {
  return {
    id: itemId,
    texturePath: texture.texturePath,
    sourceTexture: texture.sourceTexture,
    sourceModel: texture.sourceModel,
    registration: parsedItem?.registration ?? null,
    maxStackSize: parsedItem?.maxStackSize ?? null,
    maxDamage: parsedItem?.maxDamage ?? null,
    rarity: parsedItem?.rarity ?? null,
    fireResistant: parsedItem?.fireResistant ?? null,
    creativeTabs,
    food: parsedFood
      ? {
          id: parsedFood.id,
          nutrition: parsedFood.nutrition,
          saturationModifier: parsedFood.saturationModifier,
          alwaysEdible: parsedFood.alwaysEdible,
          effectCount: parsedFood.effects.length,
        }
      : null,
    blockLoot: parsedItem?.blockLoot
      ? {
          behavior: parsedItem.blockLoot.behavior,
          noLootTable: parsedItem.blockLoot.noLootTable,
          overrideLootSourceBlock: parsedItem.blockLoot.overrideLootSourceBlock,
          lootMethod: vanillaBlockLootEntry?.lootMethod ?? null,
          lootDropField: vanillaBlockLootEntry?.lootDropField ?? null,
        }
      : null,
  };
}

function normalizeFoodReference(reference: string | null): string | null {
  if (!reference) {
    return null;
  }

  const fullMatch = /(?:net\.minecraft\.world\.food\.)?Foods\.([A-Z0-9_]+)/.exec(reference);
  if (fullMatch) {
    return `Foods.${fullMatch[1]}`;
  }

  const fieldMatch = /^\s*([A-Z0-9_]+)\s*$/.exec(reference);
  if (fieldMatch) {
    return `Foods.${fieldMatch[1]}`;
  }

  return null;
}

function resolveParsedFood(
  foodReference: string | null,
  foodByReference: Map<string, ParsedFood>,
  foodByFieldName: Map<string, ParsedFood>,
): ParsedFood | null {
  if (!foodReference) {
    return null;
  }

  const normalized = normalizeFoodReference(foodReference);
  if (normalized && foodByReference.has(normalized)) {
    return foodByReference.get(normalized) ?? null;
  }

  const fallbackField = /([A-Z0-9_]+)\s*$/.exec(foodReference)?.[1] ?? null;
  if (fallbackField && foodByFieldName.has(fallbackField)) {
    return foodByFieldName.get(fallbackField) ?? null;
  }

  return null;
}

function omitNullOrFalseProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitNullOrFalseProperties(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === false) {
      continue;
    }

    const nested = omitNullOrFalseProperties(raw);
    if (nested === null || nested === false) {
      continue;
    }

    cleaned[key] = nested;
  }

  return cleaned;
}

function shouldIncludeInPlannerCatalog(
  itemId: string,
  parsedItem: ParsedItem | null,
  creativeTabs: string[],
  vanillaBlockLootEntry: VanillaBlockLootEntry | null,
): boolean {
  if (
    itemId === "ender_dragon_spawn_egg" ||
    itemId === "wither_spawn_egg" ||
    itemId === "vault" ||
    itemId === "frogspawn" ||
    itemId === "player_head" ||
    itemId === "written_book" ||
    itemId === "firework_star" ||
    itemId === "budding_amethyst"
  ) {
    return false;
  }

  if (parsedItem?.maxStackSize === 1) {
    return false;
  }

  if (parsedItem?.blockLoot?.noLootTable === true) {
    return false;
  }

  if (vanillaBlockLootEntry?.lootMethod === "drop_other") {
    return false;
  }

  if (creativeTabs.includes("spawn_eggs")) {
    return false;
  }

  return true;
}

async function main(): Promise<void> {
  const {
    itemsJavaSource,
    blocksJavaSource,
    foodsJavaSource,
    creativeModeTabsJavaSource,
    vanillaBlockLootJavaSource,
    jarPath,
    cacheVersionRoot,
    minecraftVersion,
  } = await loadJavaSources();

  if (!activeAssetsRoot) {
    if (!jarPath || !cacheVersionRoot) {
      throw new Error(
        "Jar-backed asset extraction requires decompiled source mode (local Java overrides are unsupported for fetch:items).",
      );
    }
    activeAssetsRoot = await ensureAssetsExtractedFromJar(jarPath, cacheVersionRoot);
  }

  console.log(`Using local assets from ${activeAssetsRoot}`);

  const parsedBlocks = parseBlocks(blocksJavaSource);
  const blockMap = new Map(parsedBlocks.map((block) => [block.fieldName, block]));
  const parsedItems = parseItems(itemsJavaSource, blockMap);
  const vanillaBlockLootEntries = vanillaBlockLootJavaSource
    ? parseVanillaBlockLoot(vanillaBlockLootJavaSource)
    : [];
  const vanillaBlockLootByField = new Map(
    vanillaBlockLootEntries.map((entry) => [entry.blockField, entry]),
  );
  const parsedItemById = new Map(parsedItems.map((item) => [item.id, item]));
  const parsedItemByFieldName = new Map(parsedItems.map((item) => [item.fieldName, item]));
  const parsedFoods = foodsJavaSource ? parseFoods(foodsJavaSource) : [];
  const parsedFoodByReference = new Map(parsedFoods.map((food) => [food.reference, food]));
  const parsedFoodByFieldName = new Map(parsedFoods.map((food) => [food.fieldName, food]));
  const parsedCreativeTabs = creativeModeTabsJavaSource
    ? parseCreativeModeTabs(creativeModeTabsJavaSource)
    : [];

  const creativeTabIdsByItemId = new Map<string, Set<string>>();
  const unresolvedCreativeTabItemFieldNames = new Set<string>();
  for (const tab of parsedCreativeTabs) {
    for (const itemField of tab.itemFields) {
      const parsedItem = parsedItemByFieldName.get(itemField);
      if (!parsedItem) {
        unresolvedCreativeTabItemFieldNames.add(itemField);
        continue;
      }

      if (!creativeTabIdsByItemId.has(parsedItem.id)) {
        creativeTabIdsByItemId.set(parsedItem.id, new Set<string>());
      }
      creativeTabIdsByItemId.get(parsedItem.id)!.add(tab.id);
    }
  }

  const itemIndex = await fetchItemIndex();
  const itemIdsSet = new Set<string>([
    ...Object.keys(itemIndex),
    ...parsedItemById.keys(),
  ]);
  let itemIds = Array.from(itemIdsSet).sort();
  if (ITEM_LIMIT > 0) {
    itemIds = itemIds.slice(0, ITEM_LIMIT);
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });
  await rm(OUTPUT_TEXTURE_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_TEXTURE_ROOT, { recursive: true });

  const outputItems: OutputItem[] = [];
  const missingTextureItems: string[] = [];
  const otherSpecialItems: string[] = [];
  const skippedFilteredItems: string[] = [];

  let processedCount = 0;
  let texturedCount = 0;
  let skippedCount = 0;

  await mapWithConcurrency(itemIds, CONCURRENCY, async (itemId, index) => {
    const definition = itemIndex[itemId] ?? {};
    const parsedItem = parsedItemById.get(itemId) ?? null;
    const creativeTabs = parsedItem
      ? Array.from(creativeTabIdsByItemId.get(parsedItem.id) ?? [])
      : [];
    const vanillaBlockLootEntry = parsedItem?.blockField
      ? (vanillaBlockLootByField.get(parsedItem.blockField) ?? null)
      : null;
    if (!shouldIncludeInPlannerCatalog(itemId, parsedItem, creativeTabs, vanillaBlockLootEntry)) {
      skippedFilteredItems.push(itemId);
      skippedCount += 1;
      processedCount += 1;
      if (processedCount % 100 === 0 || processedCount === itemIds.length) {
        console.log(`Processed ${processedCount}/${itemIds.length} items...`);
      }
      return;
    }

    const hasSpecial = hasSpecialRenderer(definition.model);
    const resolved = await resolveItemTexture(itemId, definition);
    const parsedFood = resolveParsedFood(
      parsedItem?.foodReference ?? null,
      parsedFoodByReference,
      parsedFoodByFieldName,
    );

    if (resolved) {
      const textureFilename = `${itemId}.png`;
      await writeFile(path.join(OUTPUT_TEXTURE_ROOT, textureFilename), resolved.bytes);
      if (hasSpecial && resolved.sourceModel !== "minecraft:special") {
        otherSpecialItems.push(itemId);
      }

      outputItems.push(toOutputItem(
        itemId,
        {
          texturePath: `/items/textures/${textureFilename}`,
          sourceTexture: resolved.textureRef,
          sourceModel: resolved.sourceModel,
        },
        parsedItem,
        parsedFood,
        creativeTabs,
        vanillaBlockLootEntry,
      ));
      texturedCount += 1;
    } else {
      if (hasSpecial) {
        otherSpecialItems.push(itemId);
      }
      missingTextureItems.push(itemId);
    }

    processedCount += 1;
    if (processedCount % 100 === 0 || processedCount === itemIds.length) {
      console.log(`Processed ${processedCount}/${itemIds.length} items...`);
    }
  });

  const sortedOutputItems = [...outputItems].sort((a, b) => a.id.localeCompare(b.id));

  const output = {
    generatedAt: new Date().toISOString(),
    gameVersion: minecraftVersion?.replace(/_unobfuscated$/, "") ?? null,
    counts: {
      itemCount: outputItems.length,
      texturedItemCount: texturedCount,
      missingTextureItemCount: missingTextureItems.length,
      filteredOutItemCount: skippedCount,
      codeItemCount: parsedItems.length,
      itemsWithCodeDataCount: outputItems.filter((item) => item.registration !== null).length,
      blockCount: parsedBlocks.length,
      noLootTableBlockCount: parsedBlocks.filter((block) => block.loot.noLootTable).length,
      overrideLootTableBlockCount: parsedBlocks.filter(
        (block) => block.loot.overrideLootTable !== null,
      ).length,
      foodDefinitionCount: parsedFoods.length,
      itemsWithFoodReferenceCount: parsedItems.filter((item) => item.foodReference !== null).length,
      itemsWithFoodDataCount: outputItems.filter((item) => item.food !== null).length,
      creativeTabCount: parsedCreativeTabs.length,
      creativeTabsWithItemsCount: parsedCreativeTabs.filter((tab) => tab.itemFields.length > 0)
        .length,
      itemsWithCreativeTabCount: outputItems.filter((item) => item.creativeTabs.length > 0).length,
      unresolvedCreativeTabItemFieldCount: unresolvedCreativeTabItemFieldNames.size,
    },
    items: sortedOutputItems,
  };

  const cleanedOutput = omitNullOrFalseProperties(output);
  await writeFile(OUTPUT_INDEX_PATH, `${JSON.stringify(cleanedOutput, null, 2)}\n`, "utf8");

  console.log(`Wrote ${OUTPUT_INDEX_PATH}`);
  console.log(`Wrote ${texturedCount} textures to ${OUTPUT_TEXTURE_ROOT}`);

  if (missingTextureItems.length > 0) {
    const sample = missingTextureItems.slice(0, 12).join(", ");
    const suffix = missingTextureItems.length > 12 ? ", ..." : "";
    console.warn(
      `Missing texture for ${missingTextureItems.length} items: ${sample}${suffix}`,
    );
  }

  if (skippedFilteredItems.length > 0) {
    console.log(
      `Filtered out ${skippedFilteredItems.length} unused items before rendering`,
    );
  }

  if (otherSpecialItems.length > 0) {
    const sorted = Array.from(new Set(otherSpecialItems)).sort();
    console.warn(
      `Special-render items without special folder render (${sorted.length}): ${sorted.join(", ")}`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
