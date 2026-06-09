import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import type {
  BlockStatesParseResult,
  BlockStateModelDefinition,
  BlockStateMultipartCondition,
  ParsedBlockStateDefinition,
} from "../parsers/block-states";
import type { BlocksParseResult } from "../parsers/blocks";
import type { ItemsParseResult } from "../parsers/items";

type JsonRecord = Record<string, unknown>;

type ModelFile = {
  parent?: string;
  textures?: Record<string, string | { sprite?: string }>;
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

type ModelRenderRequest = {
  modelRef: string;
  x: number | null;
  y: number | null;
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

export type RenderingEntry = {
  id: string;
  kind: "item" | "block";
  outputPath: string | null;
  relativePath: string | null;
  sourceType: "special" | "model" | "texture" | "missing";
  sourceRef: string | null;
  sourceModel: string | null;
  specialRenderer: boolean;
  diagnostics: string[];
};

export type RenderingsResult = {
  items: RenderingEntry[];
  blocks: RenderingEntry[];
  itemById: Record<string, RenderingEntry>;
  blockById: Record<string, RenderingEntry>;
  counts: {
    itemsRendered: number;
    blocksRendered: number;
    itemsMissing: number;
    blocksMissing: number;
    specialRendered: number;
  };
};

export type RenderMinecraftAssetsOptions = {
  assetsRoot: string;
  outputRoot: string;
  publicPathPrefix?: string;
  specialTextureRoot?: string;
  size?: number;
  supersample?: number;
  concurrency?: number;
  logger?: Pick<Console, "log" | "warn">;
};

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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function stripMinecraftNamespace(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

function normalizeSpecialTextureKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
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

function parseNamespacedRef(ref: string, defaultNamespace = "minecraft"): {
  namespace: string;
  assetPath: string;
} {
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
  const withExtension = withTextureDir.endsWith(".png") ? withTextureDir : `${withTextureDir}.png`;
  return `assets/${parsed.namespace}/${withExtension}`;
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
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function parsePng(bytes: Buffer): ParsedPng | null {
  if (bytes.length < PNG_SIGNATURE.length + 12 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
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
    offset += length + 4;
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

  if (width <= 0 || height <= 0 || bitDepth < 0 || colorType < 0) {
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
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  return channels > 0 ? channels * bitDepth : null;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function decodePngScanlines(
  inflated: Buffer,
  rowByteLength: number,
  rowCount: number,
  bytesPerPixel: number,
): Buffer | null {
  if (inflated.length !== rowCount * (rowByteLength + 1)) {
    return null;
  }
  const decoded = Buffer.alloc(rowCount * rowByteLength);
  for (let row = 0; row < rowCount; row += 1) {
    const srcStart = row * (rowByteLength + 1);
    const filterType = inflated[srcStart];
    const srcRow = inflated.subarray(srcStart + 1, srcStart + 1 + rowByteLength);
    const dstStart = row * rowByteLength;
    if (filterType === 0) {
      srcRow.copy(decoded, dstStart);
    } else if (filterType === 1) {
      for (let i = 0; i < rowByteLength; i += 1) {
        const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
        decoded[dstStart + i] = (srcRow[i] + left) & 0xff;
      }
    } else if (filterType === 2) {
      const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
      for (let i = 0; i < rowByteLength; i += 1) {
        const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
        decoded[dstStart + i] = (srcRow[i] + up) & 0xff;
      }
    } else if (filterType === 3) {
      const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
      for (let i = 0; i < rowByteLength; i += 1) {
        const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
        const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
        decoded[dstStart + i] = (srcRow[i] + Math.floor((left + up) / 2)) & 0xff;
      }
    } else if (filterType === 4) {
      const prevStart = row > 0 ? (row - 1) * rowByteLength : -1;
      for (let i = 0; i < rowByteLength; i += 1) {
        const left = i >= bytesPerPixel ? decoded[dstStart + i - bytesPerPixel] : 0;
        const up = prevStart >= 0 ? decoded[prevStart + i] : 0;
        const upLeft = prevStart >= 0 && i >= bytesPerPixel ? decoded[prevStart + i - bytesPerPixel] : 0;
        decoded[dstStart + i] = (srcRow[i] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      return null;
    }
  }
  return decoded;
}

function decodePngToRgbaImage(bytes: Buffer): RgbaImage | null {
  const parsed = parsePng(bytes);
  if (!parsed || parsed.compressionMethod !== 0 || parsed.filterMethod !== 0 || parsed.interlaceMethod !== 0) {
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
  const decodedRows = decodePngScanlines(
    inflateSync(parsed.idatData),
    rowByteLength,
    parsed.height,
    Math.max(1, Math.ceil(bitsPerPixel / 8)),
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
      const dstOffset = (y * parsed.width + x) * 4;
      if (parsed.colorType === 6) {
        const srcOffset = rowOffset + x * 4;
        rgba[dstOffset] = decodedRows[srcOffset];
        rgba[dstOffset + 1] = decodedRows[srcOffset + 1];
        rgba[dstOffset + 2] = decodedRows[srcOffset + 2];
        rgba[dstOffset + 3] = decodedRows[srcOffset + 3];
      } else if (parsed.colorType === 2) {
        const srcOffset = rowOffset + x * 3;
        rgba[dstOffset] = decodedRows[srcOffset];
        rgba[dstOffset + 1] = decodedRows[srcOffset + 1];
        rgba[dstOffset + 2] = decodedRows[srcOffset + 2];
        rgba[dstOffset + 3] = 255;
      } else if (parsed.colorType === 0) {
        const gray = decodedRows[rowOffset + x];
        rgba[dstOffset] = gray;
        rgba[dstOffset + 1] = gray;
        rgba[dstOffset + 2] = gray;
        rgba[dstOffset + 3] = 255;
      } else if (parsed.colorType === 4) {
        const srcOffset = rowOffset + x * 2;
        const gray = decodedRows[srcOffset];
        rgba[dstOffset] = gray;
        rgba[dstOffset + 1] = gray;
        rgba[dstOffset + 2] = gray;
        rgba[dstOffset + 3] = decodedRows[srcOffset + 1];
      } else if (parsed.colorType === 3) {
        if (!palette) {
          return null;
        }
        const index = parsed.bitDepth === 8
          ? decodedRows[rowOffset + x]
          : parsed.bitDepth === 4
            ? ((decodedRows[rowOffset + (x >> 1)] >> ((x & 1) === 0 ? 4 : 0)) & 0x0f)
            : parsed.bitDepth === 2
              ? ((decodedRows[rowOffset + (x >> 2)] >> (6 - (x & 0x3) * 2)) & 0x03)
              : ((decodedRows[rowOffset + (x >> 3)] >> (7 - (x & 0x7))) & 0x01);
        const paletteOffset = index * 3;
        if (paletteOffset + 2 >= palette.length) {
          return null;
        }
        rgba[dstOffset] = palette[paletteOffset];
        rgba[dstOffset + 1] = palette[paletteOffset + 1];
        rgba[dstOffset + 2] = palette[paletteOffset + 2];
        rgba[dstOffset + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
  }

  return { width: parsed.width, height: parsed.height, data: rgba };
}

function encodeRgbaImageToPng(image: RgbaImage): Buffer {
  const rowByteLength = image.width * 4;
  const scanlines = Buffer.alloc((rowByteLength + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const dstOffset = y * (rowByteLength + 1);
    scanlines[dstOffset] = 0;
    image.data.copy(scanlines, dstOffset + 1, y * rowByteLength, y * rowByteLength + rowByteLength);
  }
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(image.width, 0);
  ihdrData.writeUInt32BE(image.height, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    encodePngChunk("IHDR", ihdrData),
    encodePngChunk("IDAT", deflateSync(scanlines)),
    encodePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodePngRowsWithFilterNone(rows: Buffer, rowByteLength: number): Buffer {
  const rowCount = rows.length / rowByteLength;
  const encoded = Buffer.alloc(rowCount * (rowByteLength + 1));
  for (let row = 0; row < rowCount; row += 1) {
    encoded[row * (rowByteLength + 1)] = 0;
    rows.copy(encoded, row * (rowByteLength + 1) + 1, row * rowByteLength, row * rowByteLength + rowByteLength);
  }
  return encoded;
}

function buildPngWithUpdatedImageData(parsed: ParsedPng, newHeight: number, compressedIdat: Buffer): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(parsed.width, 0);
  ihdrData.writeUInt32BE(newHeight, 4);
  ihdrData.writeUInt8(parsed.bitDepth, 8);
  ihdrData.writeUInt8(parsed.colorType, 9);
  ihdrData.writeUInt8(parsed.compressionMethod, 10);
  ihdrData.writeUInt8(parsed.filterMethod, 11);
  ihdrData.writeUInt8(parsed.interlaceMethod, 12);
  const parts = [PNG_SIGNATURE, encodePngChunk("IHDR", ihdrData), encodePngChunk("IDAT", compressedIdat)];
  parts.push(encodePngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
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
  if (isRecord(firstFrame) && typeof firstFrame.index === "number" && Number.isFinite(firstFrame.index)) {
    return Math.max(0, Math.trunc(firstFrame.index));
  }
  return 0;
}

function cropAnimatedPngToSingleFrame(textureBytes: Buffer, animationMeta: AnimationMeta): Buffer {
  const parsed = parsePng(textureBytes);
  if (!parsed || !animationMeta.animation || parsed.compressionMethod !== 0 || parsed.filterMethod !== 0 || parsed.interlaceMethod !== 0) {
    return textureBytes;
  }
  const frameWidth = toPositiveInteger(animationMeta.animation.width) ?? parsed.width;
  const frameHeight = toPositiveInteger(animationMeta.animation.height) ?? toPositiveInteger(animationMeta.animation.width) ?? parsed.width;
  if (frameWidth !== parsed.width || frameHeight <= 0 || frameHeight >= parsed.height) {
    return textureBytes;
  }
  const frameCount = Math.floor(parsed.height / frameHeight);
  if (frameCount <= 1) {
    return textureBytes;
  }
  const bitsPerPixel = bitsPerPixelForPng(parsed.colorType, parsed.bitDepth);
  if (!bitsPerPixel) {
    return textureBytes;
  }
  const rowByteLength = Math.ceil((parsed.width * bitsPerPixel) / 8);
  const decodedRows = decodePngScanlines(
    inflateSync(parsed.idatData),
    rowByteLength,
    parsed.height,
    Math.max(1, Math.ceil(bitsPerPixel / 8)),
  );
  if (!decodedRows) {
    return textureBytes;
  }
  const frameRows = Buffer.alloc(rowByteLength * frameHeight);
  const firstFrameRow = Math.min(getFirstAnimationFrameIndex(animationMeta), frameCount - 1) * frameHeight;
  for (let row = 0; row < frameHeight; row += 1) {
    decodedRows.copy(frameRows, row * rowByteLength, (firstFrameRow + row) * rowByteLength, (firstFrameRow + row + 1) * rowByteLength);
  }
  return buildPngWithUpdatedImageData(
    parsed,
    frameHeight,
    deflateSync(encodePngRowsWithFilterNone(frameRows, rowByteLength)),
  );
}

function parseModelFace(value: unknown): ModelFaceDef | null {
  if (!isRecord(value) || typeof value.texture !== "string") {
    return null;
  }
  const rotationRaw = value.rotation;
  const rotation = rotationRaw === 90 || rotationRaw === 180 || rotationRaw === 270 ? rotationRaw : 0;
  const uvRaw = value.uv;
  const tintIndexRaw = value.tintindex;
  const tintIndex = typeof tintIndexRaw === "number" && Number.isInteger(tintIndexRaw) && tintIndexRaw >= 0 ? tintIndexRaw : null;
  if (!Array.isArray(uvRaw) || uvRaw.length !== 4 || uvRaw.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    return { texture: value.texture, uv: [0, 0, 16, 16], rotation, tintIndex };
  }
  return { texture: value.texture, uv: [uvRaw[0], uvRaw[1], uvRaw[2], uvRaw[3]], rotation, tintIndex };
}

function parseModelElementRotation(value: unknown): ModelElementRotation | null {
  if (!isRecord(value) || (value.axis !== "x" && value.axis !== "y" && value.axis !== "z")) {
    return null;
  }
  if (typeof value.angle !== "number" || !Number.isFinite(value.angle)) {
    return null;
  }
  if (!Array.isArray(value.origin) || value.origin.length !== 3 || value.origin.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    return null;
  }
  return { axis: value.axis, angle: value.angle, origin: [value.origin[0], value.origin[1], value.origin[2]] };
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

function modelFace(texture: string): ModelFaceDef {
  return { texture, uv: [0, 0, 16, 16], rotation: 0, tintIndex: null };
}

function fullCubeModelDefinition(textureRef: string): ResolvedModelDefinition {
  return {
    textureMap: {
      all: textureRef,
      particle: textureRef,
    },
    elements: [{
      from: [0, 0, 0],
      to: [16, 16, 16],
      rotation: null,
      faces: {
        up: modelFace("#all"),
        down: modelFace("#all"),
        north: modelFace("#all"),
        south: modelFace("#all"),
        east: modelFace("#all"),
        west: modelFace("#all"),
      },
    }],
  };
}

class MinecraftRenderer {
  private readonly assetsRoot: string;
  private readonly specialTextureRoot: string;
  private readonly size: number;
  private readonly supersample: number;
  private readonly modelRenderView: "back" = "back";
  private readonly modelCache = new Map<string, Promise<ModelFile | null>>();
  private readonly textureMapCache = new Map<string, Promise<Record<string, string>>>();
  private readonly textureBufferCache = new Map<string, Promise<Buffer | null>>();
  private readonly textureMetaCache = new Map<string, Promise<AnimationMeta | null>>();
  private readonly resolvedModelCache = new Map<string, Promise<ResolvedModelDefinition | null>>();
  private readonly textureRgbaCache = new Map<string, Promise<RgbaImage | null>>();
  private readonly renderedModelCache = new Map<string, Promise<{ textureRef: string; bytes: Buffer } | null>>();
  private specialTextureMapPromise: Promise<Map<string, SpecialTextureEntry>> | null = null;

  constructor(options: { assetsRoot: string; specialTextureRoot: string; size: number; supersample: number }) {
    this.assetsRoot = options.assetsRoot;
    this.specialTextureRoot = options.specialTextureRoot;
    this.size = options.size;
    this.supersample = Math.max(1, options.supersample);
  }

  async renderItem(itemId: string, itemDefinition: JsonRecord): Promise<{
    sourceType: RenderingEntry["sourceType"];
    sourceRef: string | null;
    sourceModel: string | null;
    specialRenderer: boolean;
    bytes: Buffer | null;
    diagnostics: string[];
  }> {
    const specialRenderer = this.hasSpecialRenderer(itemDefinition.model);
    if (specialRenderer) {
      const shulkerBox = await this.renderSpecialShulkerBox(itemId);
      if (shulkerBox) {
        return {
          sourceType: "special",
          sourceRef: shulkerBox.textureRef,
          sourceModel: "minecraft:special/shulker_box",
          specialRenderer,
          bytes: shulkerBox.bytes,
          diagnostics: [],
        };
      }
      const specialTexture = await this.resolveSpecialTexture(itemId);
      if (specialTexture) {
        return { sourceType: "special", sourceRef: specialTexture.textureRef, sourceModel: "minecraft:special", specialRenderer, bytes: specialTexture.bytes, diagnostics: [] };
      }
    }

    const candidates = this.dedupeCandidates(this.collectCandidates(itemDefinition.model));
    for (const candidate of candidates) {
      const tintPalette = await this.resolveTintPalette(candidate.tintDefs);
      const primaryTint = tintPalette[0] ?? null;
      if (candidate.kind === "texture") {
        const bytes = await this.readTextureBuffer(candidate.ref);
        if (bytes) {
          return {
            sourceType: "texture",
            sourceRef: candidate.ref,
            sourceModel: null,
            specialRenderer,
            bytes: primaryTint ? this.tintPngBytes(bytes, primaryTint) : bytes,
            diagnostics: [],
          };
        }
      } else {
        const rendered = await this.renderTextureFromModel(candidate.ref, tintPalette);
        if (rendered) {
          return { sourceType: "model", sourceRef: rendered.textureRef, sourceModel: candidate.ref, specialRenderer, bytes: rendered.bytes, diagnostics: [] };
        }
        const resolvedTexture = await this.resolveTextureFromModel(candidate.ref);
        const bytes = resolvedTexture ? await this.readTextureBuffer(resolvedTexture) : null;
        if (bytes) {
          return {
            sourceType: "texture",
            sourceRef: resolvedTexture,
            sourceModel: candidate.ref,
            specialRenderer,
            bytes: primaryTint ? this.tintPngBytes(bytes, primaryTint) : bytes,
            diagnostics: [],
          };
        }
      }
    }

    const fallbackTextureRef = `minecraft:item/${itemId}`;
    const fallbackBytes = await this.readTextureBuffer(fallbackTextureRef);
    if (fallbackBytes) {
      return { sourceType: "texture", sourceRef: fallbackTextureRef, sourceModel: null, specialRenderer, bytes: fallbackBytes, diagnostics: [] };
    }
    return { sourceType: "missing", sourceRef: null, sourceModel: null, specialRenderer, bytes: null, diagnostics: ["No item model or texture resolved."] };
  }

  async renderBlock(blockId: string, modelDefinitions: BlockStateModelDefinition[]): Promise<{
    sourceType: RenderingEntry["sourceType"];
    sourceRef: string | null;
    sourceModel: string | null;
    specialRenderer: boolean;
    bytes: Buffer | null;
    diagnostics: string[];
  }> {
    const pathId = stripMinecraftNamespace(blockId);
    const shulkerBox = await this.renderSpecialShulkerBox(pathId);
    if (shulkerBox) {
      return {
        sourceType: "special",
        sourceRef: shulkerBox.textureRef,
        sourceModel: "minecraft:special/shulker_box",
        specialRenderer: true,
        bytes: shulkerBox.bytes,
        diagnostics: [],
      };
    }
    const specialTexture = await this.resolveSpecialTexture(pathId);
    if (specialTexture) {
      return { sourceType: "special", sourceRef: specialTexture.textureRef, sourceModel: "minecraft:special", specialRenderer: true, bytes: specialTexture.bytes, diagnostics: [] };
    }
    const requests = modelDefinitions
      .filter((definition) => definition.model)
      .map((definition) => ({
        modelRef: definition.model ?? "",
        x: definition.x,
        y: definition.y,
      }));
    if (requests.length === 0) {
      return { sourceType: "missing", sourceRef: null, sourceModel: null, specialRenderer: false, bytes: null, diagnostics: ["No blockstate model resolved."] };
    }
    const rendered = await this.renderTextureFromModels(requests, inferBlockTintPalette(pathId));
    if (rendered) {
      return { sourceType: "model", sourceRef: rendered.textureRef, sourceModel: requests.map((request) => request.modelRef).join(","), specialRenderer: false, bytes: rendered.bytes, diagnostics: [] };
    }
    const modelRef = requests[0].modelRef;
    const resolvedTexture = await this.resolveTextureFromModel(modelRef);
    const bytes = resolvedTexture ? await this.readTextureBuffer(resolvedTexture) : null;
    if (bytes) {
      return { sourceType: "texture", sourceRef: resolvedTexture, sourceModel: modelRef, specialRenderer: false, bytes, diagnostics: [] };
    }
    return { sourceType: "missing", sourceRef: null, sourceModel: modelRef, specialRenderer: false, bytes: null, diagnostics: [`No renderable elements or texture for ${modelRef}.`] };
  }

  private async readTextAssetOptional(assetPath: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.assetsRoot, assetPath), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readBinaryAssetOptional(assetPath: string): Promise<Buffer | null> {
    try {
      return await readFile(path.join(this.assetsRoot, assetPath));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async loadSpecialTextureMap(): Promise<Map<string, SpecialTextureEntry>> {
    if (this.specialTextureMapPromise) {
      return this.specialTextureMapPromise;
    }
    this.specialTextureMapPromise = (async () => {
      const map = new Map<string, SpecialTextureEntry>();
      if (!(await pathExists(this.specialTextureRoot))) {
        return map;
      }
      for (const entry of await readdir(this.specialTextureRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
          continue;
        }
        const key = normalizeSpecialTextureKey(entry.name.slice(0, -".png".length));
        if (key && !map.has(key)) {
          map.set(key, { absolutePath: path.join(this.specialTextureRoot, entry.name), filename: entry.name });
        }
      }
      return map;
    })();
    return this.specialTextureMapPromise;
  }

  private async resolveSpecialTexture(id: string): Promise<{ textureRef: string; bytes: Buffer } | null> {
    const specialTexture = (await this.loadSpecialTextureMap()).get(normalizeSpecialTextureKey(id));
    return specialTexture ? { textureRef: `special/${specialTexture.filename}`, bytes: await readFile(specialTexture.absolutePath) } : null;
  }

  private async renderSpecialShulkerBox(id: string): Promise<{ textureRef: string; bytes: Buffer } | null> {
    if (!/(^|_)shulker_box$/.test(id)) {
      return null;
    }
    const textureRef = `minecraft:block/${id}`;
    if (!(await this.readTextureBuffer(textureRef))) {
      return null;
    }
    const rendered = await this.renderTextureFromResolvedModels(
      [{
        modelRef: `minecraft:special/shulker_box/${id}`,
        x: null,
        y: null,
        resolved: fullCubeModelDefinition(textureRef),
      }],
      [],
    );
    return rendered ? { textureRef, bytes: rendered.bytes } : null;
  }

  private hasSpecialRenderer(node: unknown): boolean {
    if (Array.isArray(node)) {
      return node.some((value) => this.hasSpecialRenderer(value));
    }
    if (!isRecord(node)) {
      return false;
    }
    return node.type === "minecraft:special" || Object.values(node).some((value) => this.hasSpecialRenderer(value));
  }

  private collectCandidates(node: unknown, inheritedTintDefs: unknown[] | null = null): Candidate[] {
    const out: Candidate[] = [];
    const visit = (value: unknown, tintDefs: unknown[] | null): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          visit(entry, tintDefs);
        }
        return;
      }
      if (!isRecord(value)) {
        return;
      }
      const localTintDefs = Array.isArray(value.tints) ? value.tints : tintDefs;
      if (value.type === "minecraft:model" && typeof value.model === "string") {
        out.push({ kind: "model", ref: value.model, tintDefs: localTintDefs });
      }
      if (value.type === "minecraft:special" && typeof value.base === "string") {
        out.push({ kind: "model", ref: value.base, tintDefs: localTintDefs });
      }
      if (typeof value.texture === "string") {
        out.push({ kind: "texture", ref: value.texture, tintDefs: localTintDefs });
      }
      for (const key of ["fallback", "on_false", "model", "on_true", "cases", "entries", "models"]) {
        if (key in value) {
          visit(value[key], localTintDefs);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (["type", "texture", "fallback", "on_false", "model", "on_true", "cases", "entries", "models"].includes(key)) {
          continue;
        }
        visit(child, localTintDefs);
      }
    };
    visit(node, inheritedTintDefs);
    return out;
  }

  private dedupeCandidates(candidates: Candidate[]): Candidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.kind}:${candidate.ref}:${candidate.tintDefs ? JSON.stringify(candidate.tintDefs) : ""}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async loadModel(modelRef: string): Promise<ModelFile | null> {
    const cached = this.modelCache.get(modelRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const raw = await this.readTextAssetOptional(modelRefToAssetPath(modelRef));
      if (raw === null) {
        return null;
      }
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed as ModelFile : null;
    })();
    this.modelCache.set(modelRef, promise);
    return promise;
  }

  private async loadMergedTextureMap(modelRef: string, stack = new Set<string>()): Promise<Record<string, string>> {
    if (stack.has(modelRef)) {
      return {};
    }
    const cached = this.textureMapCache.get(modelRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const nextStack = new Set(stack).add(modelRef);
      const model = await this.loadModel(modelRef);
      if (!model) {
        return {};
      }
      const inherited = typeof model.parent === "string" ? await this.loadMergedTextureMap(model.parent, nextStack) : {};
      const own: Record<string, string> = {};
      if (isRecord(model.textures)) {
        for (const [key, value] of Object.entries(model.textures)) {
          if (typeof value === "string") {
            own[key] = value;
          } else if (isRecord(value) && typeof value.sprite === "string") {
            own[key] = value.sprite;
          }
        }
      }
      return { ...inherited, ...own };
    })();
    this.textureMapCache.set(modelRef, promise);
    return promise;
  }

  private async loadResolvedModelDefinition(modelRef: string, stack = new Set<string>()): Promise<ResolvedModelDefinition | null> {
    if (stack.has(modelRef)) {
      return null;
    }
    const cached = this.resolvedModelCache.get(modelRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const nextStack = new Set(stack).add(modelRef);
      const model = await this.loadModel(modelRef);
      if (!model) {
        return null;
      }
      const inherited = typeof model.parent === "string" ? await this.loadResolvedModelDefinition(model.parent, nextStack) : null;
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
        textureMap: { ...(inherited?.textureMap ?? {}), ...ownTextures },
        elements: ownElements.length > 0 ? ownElements : inherited?.elements ?? [],
      };
    })();
    this.resolvedModelCache.set(modelRef, promise);
    return promise;
  }

  private resolveTextureAlias(textureMap: Record<string, string>, rawTextureValue: string): string | null {
    let current = rawTextureValue;
    const visited = new Set<string>();
    while (current.startsWith("#")) {
      const key = current.slice(1);
      if (visited.has(key) || typeof textureMap[key] !== "string") {
        return null;
      }
      visited.add(key);
      current = textureMap[key];
    }
    return current;
  }

  private pickTextureFromMap(textureMap: Record<string, string>): string | null {
    for (const key of [...PREFERRED_TEXTURE_KEYS, ...Object.keys(textureMap)]) {
      const value = textureMap[key];
      if (typeof value === "string") {
        const resolved = this.resolveTextureAlias(textureMap, value);
        if (resolved) {
          return resolved;
        }
      }
    }
    return null;
  }

  private async resolveTextureFromModel(modelRef: string): Promise<string | null> {
    return this.pickTextureFromMap(await this.loadMergedTextureMap(modelRef));
  }

  private async loadTextureAnimationMeta(textureRef: string): Promise<AnimationMeta | null> {
    const cached = this.textureMetaCache.get(textureRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const raw = await this.readTextAssetOptional(textureRefToMcmetaAssetPath(textureRef));
      if (raw === null) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        return isRecord(parsed) ? parsed as AnimationMeta : null;
      } catch {
        return null;
      }
    })();
    this.textureMetaCache.set(textureRef, promise);
    return promise;
  }

  private async readTextureBuffer(textureRef: string): Promise<Buffer | null> {
    const cached = this.textureBufferCache.get(textureRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const bytes = await this.readBinaryAssetOptional(textureRefToAssetPath(textureRef));
      if (!bytes) {
        return null;
      }
      const meta = await this.loadTextureAnimationMeta(textureRef);
      return meta?.animation ? cropAnimatedPngToSingleFrame(bytes, meta) : bytes;
    })();
    this.textureBufferCache.set(textureRef, promise);
    return promise;
  }

  private async readTextureRgba(textureRef: string): Promise<RgbaImage | null> {
    const cached = this.textureRgbaCache.get(textureRef);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const bytes = await this.readTextureBuffer(textureRef);
      return bytes ? decodePngToRgbaImage(bytes) : null;
    })();
    this.textureRgbaCache.set(textureRef, promise);
    return promise;
  }

  private async resolveTintColorFromDefinition(tintDef: unknown): Promise<number | null> {
    if (!isRecord(tintDef) || typeof tintDef.type !== "string") {
      return null;
    }
    if (tintDef.type === "minecraft:constant" && typeof tintDef.value === "number") {
      return tintDef.value;
    }
    if (typeof tintDef.default === "number") {
      return tintDef.default;
    }
    if (tintDef.type === "minecraft:grass") {
      return 0x7fb238;
    }
    if (tintDef.type === "minecraft:foliage") {
      return 0x48b518;
    }
    return null;
  }

  private async resolveTintPalette(tintDefs: unknown[] | null): Promise<Array<RgbColor | null>> {
    if (!tintDefs || tintDefs.length === 0) {
      return [];
    }
    const colors = await Promise.all(tintDefs.map((def) => this.resolveTintColorFromDefinition(def)));
    return colors.map((color) => color === null ? null : { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff });
  }

  private tintPngBytes(bytes: Buffer, tintColor: RgbColor): Buffer {
    const image = decodePngToRgbaImage(bytes);
    if (!image) {
      return bytes;
    }
    return encodeRgbaImageToPng(this.applyTintToImage(image, tintColor));
  }

  private applyTintToImage(image: RgbaImage, tintColor: RgbColor): RgbaImage {
    const out = Buffer.from(image.data);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) {
        continue;
      }
      out[i] = Math.round((out[i] * tintColor.r) / 255);
      out[i + 1] = Math.round((out[i + 1] * tintColor.g) / 255);
      out[i + 2] = Math.round((out[i + 2] * tintColor.b) / 255);
    }
    return { width: image.width, height: image.height, data: out };
  }

  private async renderTextureFromModel(modelRef: string, tintPalette: Array<RgbColor | null>): Promise<{ textureRef: string; bytes: Buffer } | null> {
    return this.renderTextureFromModels([{ modelRef, x: null, y: null }], tintPalette);
  }

  private async renderTextureFromModels(requests: ModelRenderRequest[], tintPalette: Array<RgbColor | null>): Promise<{ textureRef: string; bytes: Buffer } | null> {
    const renderKey = `${requests.map((request) => `${request.modelRef}@${request.x ?? ""},${request.y ?? ""}`).join("|")}|${tintPalette.map((color) => color ? `${color.r},${color.g},${color.b}` : "null").join(";")}`;
    const cached = this.renderedModelCache.get(renderKey);
    if (cached) {
      return cached;
    }
    const promise = this.renderTextureFromModelsUncached(requests, tintPalette);
    this.renderedModelCache.set(renderKey, promise);
    return promise;
  }

  private async renderTextureFromModelsUncached(requests: ModelRenderRequest[], tintPalette: Array<RgbColor | null>): Promise<{ textureRef: string; bytes: Buffer } | null> {
    const resolvedRequests = (
      await Promise.all(requests.map(async (request) => ({
        ...request,
        resolved: await this.loadResolvedModelDefinition(request.modelRef),
      })))
    ).filter((request): request is ModelRenderRequest & { resolved: ResolvedModelDefinition } => Boolean(request.resolved));
    return this.renderTextureFromResolvedModels(resolvedRequests, tintPalette);
  }

  private async renderTextureFromResolvedModels(
    requests: Array<ModelRenderRequest & { resolved: ResolvedModelDefinition }>,
    tintPalette: Array<RgbColor | null>,
  ): Promise<{ textureRef: string; bytes: Buffer } | null> {
    const facesToRender: Array<{
      points: Vec3[];
      uvCorners: Array<{ u: number; v: number }>;
      textureRef: string;
      depth: number;
      tintColor: RgbColor | null;
    }> = [];
    const viewDirection = normalizeVec3({ x: -1, y: 1, z: -1 });
    for (const request of requests) {
      const resolved = request.resolved;
      if (resolved.elements.length === 0) {
        continue;
      }
      for (const element of resolved.elements) {
        for (const faceName of ["up", "down", "north", "south", "east", "west"] as const) {
          const face = element.faces[faceName];
          if (!face) {
            continue;
          }
          const textureRef = this.resolveTextureAlias(resolved.textureMap, face.texture);
          if (!textureRef) {
            continue;
          }
          const geometry = getFaceGeometry(faceName, element.from[0], element.from[1], element.from[2], element.to[0], element.to[1], element.to[2]);
          const elementRotatedPoints = geometry.points.map((point) => rotatePointAroundElementRotation(point, element.rotation));
          const rotatedPoints = elementRotatedPoints.map((point) => rotatePointForBlockState(point, request.x, request.y));
          const elementNormal = normalizeVec3(rotateVectorAroundAxis(geometry.normal, element.rotation?.axis ?? "x", element.rotation ? (element.rotation.angle * Math.PI) / 180 : 0));
          const rotatedNormal = normalizeVec3(rotateVectorForBlockState(elementNormal, request.x, request.y));
          const facing = rotatedNormal.x * viewDirection.x + rotatedNormal.y * viewDirection.y + rotatedNormal.z * viewDirection.z;
          if (facing <= 1e-4) {
            continue;
          }
          const [u1, v1, u2, v2] = face.uv;
          const uvCorners = rotateUvCorners([{ u: u1, v: v1 }, { u: u2, v: v1 }, { u: u2, v: v2 }, { u: u1, v: v2 }], face.rotation);
          const centroid = rotatedPoints.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }), { x: 0, y: 0, z: 0 });
          centroid.x /= rotatedPoints.length;
          centroid.y /= rotatedPoints.length;
          centroid.z /= rotatedPoints.length;
          facesToRender.push({
            points: rotatedPoints,
            uvCorners,
            textureRef,
            depth: centroid.x * viewDirection.x + centroid.y * viewDirection.y + centroid.z * viewDirection.z,
            tintColor: face.tintIndex === null ? null : tintPalette[face.tintIndex] ?? null,
          });
        }
      }
    }
    if (facesToRender.length === 0) {
      return null;
    }
    const bounds = getFullBlockProjectionBounds(this.modelRenderView);
    const outputSize = Math.max(16, this.size);
    const supersampledSize = outputSize * this.supersample;
    const padding = this.supersample;
    const scale = Math.min(
      (supersampledSize - padding * 2) / Math.max(1e-6, bounds.maxX - bounds.minX),
      (supersampledSize - padding * 2) / Math.max(1e-6, bounds.maxY - bounds.minY),
    );
    const output: RgbaImage = { width: supersampledSize, height: supersampledSize, data: Buffer.alloc(supersampledSize * supersampledSize * 4) };
    for (const face of facesToRender.sort((a, b) => a.depth - b.depth)) {
      const texture = await this.readTextureRgba(face.textureRef);
      if (!texture) {
        continue;
      }
      const mapped = face.points.map((point) => {
        const projected = projectModelPointForView(point.x, point.y, point.z, this.modelRenderView);
        return { x: (projected.x - bounds.minX) * scale + padding, y: (projected.y - bounds.minY) * scale + padding };
      });
      const vertices: ScreenVertex[] = [
        { ...mapped[0], u: face.uvCorners[0].u, v: face.uvCorners[0].v },
        { ...mapped[1], u: face.uvCorners[1].u, v: face.uvCorners[1].v },
        { ...mapped[2], u: face.uvCorners[2].u, v: face.uvCorners[2].v },
        { ...mapped[3], u: face.uvCorners[3].u, v: face.uvCorners[3].v },
      ];
      drawTexturedTriangle(output, texture, vertices[0], vertices[1], vertices[2], face.tintColor);
      drawTexturedTriangle(output, texture, vertices[0], vertices[2], vertices[3], face.tintColor);
    }
    if (![...output.data].some((_value, index) => index % 4 === 3 && output.data[index] > 0)) {
      return null;
    }
    const finalImage = this.supersample > 1 ? downsampleRgbaImage(output, outputSize, outputSize) : output;
    return { textureRef: facesToRender[0].textureRef, bytes: encodeRgbaImageToPng(finalImage) };
  }
}

type Vec3 = { x: number; y: number; z: number };
type ScreenVertex = { x: number; y: number; u: number; v: number };

function projectModelPoint(x: number, y: number, z: number): { x: number; y: number } {
  return { x: x - z, y: (x + z) * 0.5 - y * 1.15 };
}

function projectModelPointForView(x: number, y: number, z: number, view: "front" | "back"): { x: number; y: number } {
  return view === "back" ? projectModelPoint(16 - x, y, 16 - z) : projectModelPoint(x, y, z);
}

function getFullBlockProjectionBounds(view: "front" | "back"): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = [
    projectModelPointForView(0, 0, 0, view),
    projectModelPointForView(16, 0, 0, view),
    projectModelPointForView(0, 0, 16, view),
    projectModelPointForView(16, 0, 16, view),
    projectModelPointForView(0, 16, 0, view),
    projectModelPointForView(16, 16, 0, view),
    projectModelPointForView(0, 16, 16, view),
    projectModelPointForView(16, 16, 16, view),
  ];
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function rotateVectorAroundAxis(vector: Vec3, axis: "x" | "y" | "z", radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  if (axis === "x") {
    return { x: vector.x, y: vector.y * c - vector.z * s, z: vector.y * s + vector.z * c };
  }
  if (axis === "y") {
    return { x: vector.x * c + vector.z * s, y: vector.y, z: -vector.x * s + vector.z * c };
  }
  return { x: vector.x * c - vector.y * s, y: vector.x * s + vector.y * c, z: vector.z };
}

function rotatePointAroundElementRotation(point: Vec3, rotation: ModelElementRotation | null): Vec3 {
  if (!rotation || rotation.angle === 0) {
    return point;
  }
  const translated = { x: point.x - rotation.origin[0], y: point.y - rotation.origin[1], z: point.z - rotation.origin[2] };
  const rotated = rotateVectorAroundAxis(translated, rotation.axis, (rotation.angle * Math.PI) / 180);
  return { x: rotated.x + rotation.origin[0], y: rotated.y + rotation.origin[1], z: rotated.z + rotation.origin[2] };
}

function rotatePointForBlockState(point: Vec3, xRotation: number | null, yRotation: number | null): Vec3 {
  const centered = { x: point.x - 8, y: point.y - 8, z: point.z - 8 };
  const xRotated = xRotation ? rotateVectorAroundAxis(centered, "x", (xRotation * Math.PI) / 180) : centered;
  const yRotated = yRotation ? rotateVectorAroundAxis(xRotated, "y", (yRotation * Math.PI) / 180) : xRotated;
  return { x: yRotated.x + 8, y: yRotated.y + 8, z: yRotated.z + 8 };
}

function rotateVectorForBlockState(vector: Vec3, xRotation: number | null, yRotation: number | null): Vec3 {
  const xRotated = xRotation ? rotateVectorAroundAxis(vector, "x", (xRotation * Math.PI) / 180) : vector;
  return yRotation ? rotateVectorAroundAxis(xRotated, "y", (yRotation * Math.PI) / 180) : xRotated;
}

function normalizeVec3(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length <= 1e-8 ? { x: 0, y: 0, z: 0 } : { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function getFaceGeometry(faceName: "up" | "down" | "north" | "south" | "east" | "west", x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): { points: Vec3[]; normal: Vec3 } {
  if (faceName === "up") return { points: [{ x: x1, y: y2, z: z1 }, { x: x2, y: y2, z: z1 }, { x: x2, y: y2, z: z2 }, { x: x1, y: y2, z: z2 }], normal: { x: 0, y: 1, z: 0 } };
  if (faceName === "down") return { points: [{ x: x1, y: y1, z: z2 }, { x: x2, y: y1, z: z2 }, { x: x2, y: y1, z: z1 }, { x: x1, y: y1, z: z1 }], normal: { x: 0, y: -1, z: 0 } };
  if (faceName === "north") return { points: [{ x: x2, y: y2, z: z1 }, { x: x1, y: y2, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x2, y: y1, z: z1 }], normal: { x: 0, y: 0, z: -1 } };
  if (faceName === "south") return { points: [{ x: x1, y: y2, z: z2 }, { x: x2, y: y2, z: z2 }, { x: x2, y: y1, z: z2 }, { x: x1, y: y1, z: z2 }], normal: { x: 0, y: 0, z: 1 } };
  if (faceName === "east") return { points: [{ x: x2, y: y2, z: z1 }, { x: x2, y: y2, z: z2 }, { x: x2, y: y1, z: z2 }, { x: x2, y: y1, z: z1 }], normal: { x: 1, y: 0, z: 0 } };
  return { points: [{ x: x1, y: y2, z: z2 }, { x: x1, y: y2, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x1, y: y1, z: z2 }], normal: { x: -1, y: 0, z: 0 } };
}

function rotateUvCorners(corners: Array<{ u: number; v: number }>, rotation: 0 | 90 | 180 | 270): Array<{ u: number; v: number }> {
  let rotated = corners;
  for (let i = 0; i < rotation / 90; i += 1) {
    rotated = [rotated[3], rotated[0], rotated[1], rotated[2]];
  }
  return rotated;
}

function alphaBlendPixel(target: Buffer, offset: number, r: number, g: number, b: number, a: number): void {
  const srcA = a / 255;
  if (srcA <= 0) return;
  const dstA = target[offset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  target[offset] = Math.round((r * srcA + target[offset] * dstA * (1 - srcA)) / outA);
  target[offset + 1] = Math.round((g * srcA + target[offset + 1] * dstA * (1 - srcA)) / outA);
  target[offset + 2] = Math.round((b * srcA + target[offset + 2] * dstA * (1 - srcA)) / outA);
  target[offset + 3] = Math.round(outA * 255);
}

function sampleTextureRgbaWithAlphaBleed(texture: RgbaImage, u: number, v: number): { r: number; g: number; b: number; a: number } {
  const tx = Math.max(0, Math.min(texture.width - 1, Math.floor((u / 16) * texture.width)));
  const ty = Math.max(0, Math.min(texture.height - 1, Math.floor((v / 16) * texture.height)));
  const offset = (ty * texture.width + tx) * 4;
  return { r: texture.data[offset], g: texture.data[offset + 1], b: texture.data[offset + 2], a: texture.data[offset + 3] };
}

function drawTexturedTriangle(target: RgbaImage, texture: RgbaImage, v0: ScreenVertex, v1: ScreenVertex, v2: ScreenVertex, tintColor: RgbColor | null): void {
  const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x)) - 1);
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x)) + 1);
  const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y)) - 1);
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y)) + 1);
  const denom = (v1.y - v2.y) * (v0.x - v2.x) + (v2.x - v1.x) * (v0.y - v2.y);
  if (Math.abs(denom) < 1e-6) return;
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const sx = px + 0.5;
      const sy = py + 0.5;
      const w0 = ((v1.y - v2.y) * (sx - v2.x) + (v2.x - v1.x) * (sy - v2.y)) / denom;
      const w1 = ((v2.y - v0.y) * (sx - v2.x) + (v0.x - v2.x) * (sy - v2.y)) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
      const sampled = sampleTextureRgbaWithAlphaBleed(texture, w0 * v0.u + w1 * v1.u + w2 * v2.u, w0 * v0.v + w1 * v1.v + w2 * v2.v);
      if (sampled.a === 0) continue;
      alphaBlendPixel(
        target.data,
        (py * target.width + px) * 4,
        tintColor ? Math.round((sampled.r * tintColor.r) / 255) : sampled.r,
        tintColor ? Math.round((sampled.g * tintColor.g) / 255) : sampled.g,
        tintColor ? Math.round((sampled.b * tintColor.b) / 255) : sampled.b,
        sampled.a,
      );
    }
  }
}

function downsampleRgbaImage(source: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  if (source.width === targetWidth && source.height === targetHeight) {
    return source;
  }
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sx0 = Math.floor(tx * scaleX);
      const sx1 = Math.min(source.width, Math.floor((tx + 1) * scaleX));
      const sy0 = Math.floor(ty * scaleY);
      const sy1 = Math.min(source.height, Math.floor((ty + 1) * scaleY));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy += 1) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx += 1) {
          const srcOffset = (sy * source.width + sx) * 4;
          r += source.data[srcOffset]; g += source.data[srcOffset + 1]; b += source.data[srcOffset + 2]; a += source.data[srcOffset + 3]; count += 1;
        }
      }
      const dstOffset = (ty * targetWidth + tx) * 4;
      out[dstOffset] = Math.round(r / count);
      out[dstOffset + 1] = Math.round(g / count);
      out[dstOffset + 2] = Math.round(b / count);
      out[dstOffset + 3] = Math.round(a / count);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, values.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

async function loadItemDefinitionMap(assetsRoot: string): Promise<Record<string, JsonRecord>> {
  const directory = path.join(assetsRoot, "assets", "minecraft", "items");
  const itemIndex: Record<string, JsonRecord> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const parsed = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown;
    if (isRecord(parsed)) {
      itemIndex[entry.name.slice(0, -".json".length)] = parsed;
    }
  }
  return itemIndex;
}

function representativeBlockStateProperties(blockState: ParsedBlockStateDefinition): Record<string, string> {
  const properties = Object.fromEntries(
    Object.entries(blockState.propertyValues).flatMap(([key, values]) => {
      const representative = representativePropertyValue(key, values);
      return representative ? [[key, representative]] : [];
    }),
  );
  const cardinalKeys = ["north", "east", "south", "west"];
  if (cardinalKeys.every((key) => blockState.propertyValues[key]?.includes("true"))) {
    properties.north = "true";
    properties.east = "false";
    properties.south = "true";
    properties.west = "false";
  }
  return properties;
}

function representativePropertyValue(key: string, values: string[]): string | null {
  const preferences: Record<string, string[]> = {
    age: [...values].sort((left, right) => Number(right) - Number(left)),
    axis: ["y", "x", "z"],
    face: ["floor", "wall", "ceiling"],
    facing: ["west", "south", "north", "east"],
    half: ["bottom", "lower", "top", "upper"],
    hinge: ["left", "right"],
    lit: ["false"],
    open: ["false"],
    part: ["foot", "head"],
    powered: ["false"],
    shape: ["straight", "north_south", "east_west", "none"],
    type: ["bottom", "single", "double", "top"],
    waterlogged: ["false"],
  };
  for (const preferred of preferences[key] ?? ["false", "none"]) {
    if (values.includes(preferred)) {
      return preferred;
    }
  }
  return values[0] ?? null;
}

function matchesMultipartCondition(
  condition: BlockStateMultipartCondition | null,
  properties: Record<string, string>,
): boolean {
  if (!condition) {
    return true;
  }
  if (condition.kind === "properties") {
    return Object.entries(condition.properties).every(([key, values]) => values.includes(properties[key] ?? ""));
  }
  if (condition.kind === "and") {
    return condition.terms.every((term) => matchesMultipartCondition(term, properties));
  }
  if (condition.kind === "or") {
    return condition.terms.some((term) => matchesMultipartCondition(term, properties));
  }
  return false;
}

function pickBlockStateModels(blockState: ParsedBlockStateDefinition | null | undefined): BlockStateModelDefinition[] {
  if (!blockState) {
    return [];
  }
  const representativeProperties = representativeBlockStateProperties(blockState);
  if (blockState.variants.length > 0) {
    const exactVariant = blockState.variants.find((variant) =>
      Object.entries(representativeProperties).every(([key, value]) => variant.properties[key] === value),
    );
    const bestVariant = exactVariant ?? [...blockState.variants]
      .sort((left, right) =>
        variantRepresentativeScore(right.properties, representativeProperties) -
        variantRepresentativeScore(left.properties, representativeProperties),
      )[0];
    return bestVariant?.models[0] ? [bestVariant.models[0]] : [];
  }
  return blockState.multipart.flatMap((entry) =>
    matchesMultipartCondition(entry.when, representativeProperties) ? entry.apply : [],
  );
}

function variantRepresentativeScore(
  properties: Record<string, string>,
  representativeProperties: Record<string, string>,
): number {
  return Object.entries(representativeProperties)
    .reduce((score, [key, value]) => score + (properties[key] === value ? 1 : 0), 0);
}

function shouldUseBlockStateRenderingForBlock(
  pathId: string,
  blockState: ParsedBlockStateDefinition | null | undefined,
): boolean {
  return (
    Boolean(blockState?.propertyNames.includes("age")) ||
    pathId === "glass_pane" ||
    /_stained_glass_pane$/.test(pathId) ||
    /(^|_)stem$/.test(pathId) ||
    /^attached_.*_stem$/.test(pathId)
  );
}

function shouldPreferRepresentativeItemForBlock(pathId: string): boolean {
  return (
    /_wall_sign$/.test(pathId) ||
    /_wall_hanging_sign$/.test(pathId) ||
    /_wall_banner$/.test(pathId)
  );
}

function representativeItemIdForBlock(
  blockId: string,
  itemDefinitions: Record<string, JsonRecord>,
  blockItemIdByBlockId: Record<string, string>,
  blockState: ParsedBlockStateDefinition | null | undefined,
): string | null {
  const pathId = stripMinecraftNamespace(blockId);
  if (!shouldUseBlockStateRenderingForBlock(pathId, blockState)) {
    const exactBlockItem = blockItemIdByBlockId[normalizeIdentifier(pathId)];
    if (exactBlockItem && itemDefinitions[exactBlockItem]) {
      return exactBlockItem;
    }
  }

  if (!shouldPreferRepresentativeItemForBlock(pathId)) {
    return null;
  }
  const candidates = [
    pathId.replace(/_wall_hanging_sign$/, "_hanging_sign"),
    pathId.replace(/_wall_sign$/, "_sign"),
    pathId.replace(/_wall_banner$/, "_banner"),
  ];

  for (const candidate of candidates) {
    if (itemDefinitions[candidate]) {
      return candidate;
    }
  }
  return null;
}

function inferBlockTintPalette(pathId: string): Array<RgbColor | null> {
  if (/^attached_.*_stem$/.test(pathId) || /(^|_)stem$/.test(pathId)) {
    return [{ r: 0xe0, g: 0xc7, b: 0x1c }];
  }
  if (/_leaves$/.test(pathId)) {
    return [{ r: 0x48, g: 0xb5, b: 0x18 }];
  }
  if (/(^|_)grass($|_)/.test(pathId) || pathId === "fern" || pathId === "large_fern") {
    return [{ r: 0x7f, g: 0xb2, b: 0x38 }];
  }
  return [];
}

function renderingPath(input: {
  outputRoot: string;
  publicPathPrefix: string;
  kind: "items" | "blocks";
  id: string;
}): { absolutePath: string; relativePath: string } {
  const filename = `${stripMinecraftNamespace(input.id)}.png`;
  return {
    absolutePath: path.join(input.outputRoot, input.kind, filename),
    relativePath: `${input.publicPathPrefix.replace(/\/$/, "")}/${input.kind}/${filename}`,
  };
}

function attachRendering<T extends { id: string | null }>(
  entries: T[],
  renderingById: Record<string, RenderingEntry>,
): Array<T & { rendering: RenderingEntry | null }> {
  return entries.map((entry) => ({
    ...entry,
    rendering: entry.id ? renderingById[entry.id] ?? null : null,
  }));
}

export async function renderMinecraftAssets(input: {
  items: ItemsParseResult;
  blocks: BlocksParseResult;
  blockStates: BlockStatesParseResult | null;
  options: RenderMinecraftAssetsOptions;
}): Promise<{
  renderings: RenderingsResult;
  items: ItemsParseResult;
  blocks: BlocksParseResult;
}> {
  const outputRoot = input.options.outputRoot;
  const publicPathPrefix = input.options.publicPathPrefix ?? "renderings";
  const renderer = new MinecraftRenderer({
    assetsRoot: input.options.assetsRoot,
    specialTextureRoot: input.options.specialTextureRoot ?? path.resolve(process.cwd(), "itemfetch", "special"),
    size: input.options.size ?? 64,
    supersample: input.options.supersample ?? 2,
  });
  await mkdir(path.join(outputRoot, "items"), { recursive: true });
  await mkdir(path.join(outputRoot, "blocks"), { recursive: true });

  const itemDefinitions = await loadItemDefinitionMap(input.options.assetsRoot);
  const blockItemIdByBlockId = Object.fromEntries(
    input.items.items.flatMap((item) =>
      item.hasBlock && item.blockId && item.id
        ? [[item.blockId, stripMinecraftNamespace(item.id)]]
        : [],
    ),
  );
  const concurrency = input.options.concurrency ?? 16;
  const logger = input.options.logger ?? console;

  let processedItems = 0;
  const itemEntries = await mapWithConcurrency(input.items.items, concurrency, async (item) => {
    const id = item.id ?? stripMinecraftNamespace(item.fieldName.toLowerCase());
    const pathInfo = renderingPath({ outputRoot, publicPathPrefix, kind: "items", id });
    const rendered = await renderer.renderItem(stripMinecraftNamespace(id), itemDefinitions[stripMinecraftNamespace(id)] ?? {});
    if (rendered.bytes) {
      await writeFile(pathInfo.absolutePath, rendered.bytes);
    }
    processedItems += 1;
    if (processedItems % 250 === 0 || processedItems === input.items.items.length) {
      logger.log(`Rendered ${processedItems}/${input.items.items.length} item images...`);
    }
    return {
      id,
      kind: "item" as const,
      outputPath: rendered.bytes ? pathInfo.absolutePath : null,
      relativePath: rendered.bytes ? pathInfo.relativePath : null,
      sourceType: rendered.sourceType,
      sourceRef: rendered.sourceRef,
      sourceModel: rendered.sourceModel,
      specialRenderer: rendered.specialRenderer,
      diagnostics: rendered.diagnostics,
    };
  });

  let processedBlocks = 0;
  const blockEntries = await mapWithConcurrency(input.blocks.blocks, concurrency, async (block) => {
    const id = block.id ?? stripMinecraftNamespace(block.fieldName.toLowerCase());
    const pathInfo = renderingPath({ outputRoot, publicPathPrefix, kind: "blocks", id });
    const blockState = input.blockStates?.blockStateById[id] ?? block.blockStateDefinition ?? null;
    const representativeItemId = representativeItemIdForBlock(id, itemDefinitions, blockItemIdByBlockId, blockState);
    const rendered = representativeItemId
      ? await renderer.renderItem(representativeItemId, itemDefinitions[representativeItemId] ?? {})
      : await renderer.renderBlock(
        id,
        pickBlockStateModels(blockState),
      );
    if (rendered.bytes) {
      await writeFile(pathInfo.absolutePath, rendered.bytes);
    }
    processedBlocks += 1;
    if (processedBlocks % 250 === 0 || processedBlocks === input.blocks.blocks.length) {
      logger.log(`Rendered ${processedBlocks}/${input.blocks.blocks.length} block images...`);
    }
    return {
      id,
      kind: "block" as const,
      outputPath: rendered.bytes ? pathInfo.absolutePath : null,
      relativePath: rendered.bytes ? pathInfo.relativePath : null,
      sourceType: rendered.sourceType,
      sourceRef: rendered.sourceRef,
      sourceModel: rendered.sourceModel,
      specialRenderer: rendered.specialRenderer,
      diagnostics: [
        ...rendered.diagnostics,
        ...(representativeItemId && representativeItemId !== stripMinecraftNamespace(id)
          ? [`Rendered from representative item model minecraft:${representativeItemId}.`]
          : []),
      ],
    };
  });

  const itemById = Object.fromEntries(itemEntries.map((entry) => [entry.id, entry]));
  const blockById = Object.fromEntries(blockEntries.map((entry) => [entry.id, entry]));
  const renderings: RenderingsResult = {
    items: itemEntries,
    blocks: blockEntries,
    itemById,
    blockById,
    counts: {
      itemsRendered: itemEntries.filter((entry) => entry.outputPath).length,
      blocksRendered: blockEntries.filter((entry) => entry.outputPath).length,
      itemsMissing: itemEntries.filter((entry) => !entry.outputPath).length,
      blocksMissing: blockEntries.filter((entry) => !entry.outputPath).length,
      specialRendered: [...itemEntries, ...blockEntries].filter((entry) => entry.sourceType === "special").length,
    },
  };

  const renderedItems = attachRendering(input.items.items, itemById);
  const renderedBlocks = attachRendering(input.blocks.blocks, blockById);
  return {
    renderings,
    items: {
      ...input.items,
      items: renderedItems,
      itemByFieldName: Object.fromEntries(renderedItems.map((item) => [item.fieldName, item])),
      itemById: Object.fromEntries(renderedItems.flatMap((item) => item.id ? [[item.id, item]] : [])),
    },
    blocks: {
      ...input.blocks,
      blocks: renderedBlocks,
      blockByFieldName: Object.fromEntries(renderedBlocks.map((block) => [block.fieldName, block])),
      blockById: Object.fromEntries(renderedBlocks.flatMap((block) => block.id ? [[block.id, block]] : [])),
    },
  };
}
