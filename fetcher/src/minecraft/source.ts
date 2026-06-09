import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type MinecraftVersionManifestList = {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: Array<{
    id: string;
    url: string;
    releaseTime: string;
    type: string;
    sha1: string;
  }>;
};

export type MinecraftDownloadEntry = {
  url: string;
  sha1?: string;
};

export type MinecraftVersionManifest = {
  id?: string;
  downloads?: Record<string, MinecraftDownloadEntry>;
};

export type MinecraftSourceProvider = "fabric_unobfuscated" | "mojang";

export type MinecraftClassTarget = {
  id: string;
  candidates: string[];
  required?: boolean;
};

export type DecompiledMinecraftClass = {
  id: string;
  requestedCandidates: string[];
  classEntry: string;
  javaPath: string;
  javaSource: string;
};

export type MinecraftSourceBundle = {
  version: string;
  displayVersion: string;
  provider: MinecraftSourceProvider;
  manifestUrl: string;
  versionRoot: string;
  clientJarPath: string;
  clientJarUrl: string;
  clientJarSha1: string | null;
  serverJarPath: string | null;
  serverJarUrl: string | null;
  serverJarSha1: string | null;
  clientMappingsPath: string | null;
  clientMappingsUrl: string | null;
  clientMappingsSha1: string | null;
  cfrJarPath: string;
  assetsRoot: string | null;
  serverDataRoot: string | null;
  jarEntries: string[];
  classes: Record<string, DecompiledMinecraftClass | null>;
};

export type MinecraftSourceOptions = {
  version?: string;
  cacheRoot?: string;
  toolCacheRoot?: string;
  versionManifestUrl?: string;
  fabricManifestBaseUrl?: string;
  preferFabricUnobfuscated?: boolean;
  cfrVersion?: string;
  cfrJarUrl?: string;
  cfrJarPath?: string;
  classTargets?: MinecraftClassTarget[];
  extractAssets?: boolean;
  forceDecompile?: boolean;
  logger?: Pick<Console, "log" | "warn">;
};

export type DecompileMinecraftClassTargetsOptions = {
  forceDecompile?: boolean;
  concurrency?: number;
  logger?: Pick<Console, "warn">;
};

const DEFAULT_VERSION_MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const DEFAULT_FABRIC_MANIFEST_BASE_URL = "https://maven.fabricmc.net/net/minecraft";
const DEFAULT_CFR_VERSION = "0.152";
const DEFAULT_CACHE_ROOT = path.resolve(process.cwd(), "fetcher/.cache/minecraft");

export const DEFAULT_MINECRAFT_CLASS_TARGETS: MinecraftClassTarget[] = [
  {
    id: "items",
    candidates: [
      "net/minecraft/world/item/Items.class",
      "net/minecraft/references/Items.class",
    ],
  },
  {
    id: "blocks",
    candidates: ["net/minecraft/world/level/block/Blocks.class"],
  },
  {
    id: "foods",
    candidates: ["net/minecraft/world/food/Foods.class"],
    required: false,
  },
  {
    id: "creativeModeTabs",
    candidates: ["net/minecraft/world/item/CreativeModeTabs.class"],
    required: false,
  },
  {
    id: "vanillaBlockLoot",
    candidates: ["net/minecraft/data/loot/packs/VanillaBlockLoot.class"],
    required: false,
  },
  {
    id: "blockFamilies",
    candidates: ["net/minecraft/data/BlockFamilies.class"],
    required: false,
  },
  {
    id: "blockEntityTypes",
    candidates: ["net/minecraft/world/level/block/entity/BlockEntityType.class"],
    required: false,
  },
  {
    id: "fireBlock",
    candidates: ["net/minecraft/world/level/block/FireBlock.class"],
    required: false,
  },
  {
    id: "potionBrewing",
    candidates: ["net/minecraft/world/item/alchemy/PotionBrewing.class"],
    required: false,
  },
  {
    id: "villagerTrades",
    candidates: ["net/minecraft/world/item/trading/VillagerTrades.class"],
    required: false,
  },
  {
    id: "tradeRebalanceVillagerTrades",
    candidates: ["net/minecraft/world/item/trading/TradeRebalanceVillagerTrades.class"],
    required: false,
  },
  {
    id: "tradeSets",
    candidates: ["net/minecraft/world/item/trading/TradeSets.class"],
    required: false,
  },
  {
    id: "villagerTradeTags",
    candidates: ["net/minecraft/tags/VillagerTradeTags.class"],
    required: false,
  },
  {
    id: "villagerTradesTagsProvider",
    candidates: ["net/minecraft/data/tags/VillagerTradesTagsProvider.class"],
    required: false,
  },
  {
    id: "tradeRebalanceTradeTagsProvider",
    candidates: ["net/minecraft/data/tags/TradeRebalanceTradeTagsProvider.class"],
    required: false,
  },
  {
    id: "villagerProfession",
    candidates: ["net/minecraft/world/entity/npc/villager/VillagerProfession.class"],
    required: false,
  },
  {
    id: "villager",
    candidates: ["net/minecraft/world/entity/npc/villager/Villager.class"],
    required: false,
  },
  {
    id: "wanderingTrader",
    candidates: ["net/minecraft/world/entity/npc/wanderingtrader/WanderingTrader.class"],
    required: false,
  },
];

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, Buffer.from(await response.arrayBuffer()));
}

async function sha1File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha1").update(bytes).digest("hex");
}

async function runExec(
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number },
): Promise<string> {
  const result = await execFile(command, args, {
    cwd: options?.cwd,
    encoding: "utf8",
    maxBuffer: options?.maxBuffer ?? 256 * 1024 * 1024,
  });
  return result.stdout;
}

function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function toFabricManifestUrl(versionId: string, fabricManifestBaseUrl: string): string {
  return `${fabricManifestBaseUrl}/${versionId.replace(/\./g, "_")}.json`;
}

function parseOfficialClassMappings(mappingText: string): Map<string, string> {
  const classMappings = new Map<string, string>();
  for (const line of mappingText.split(/\r?\n/)) {
    if (line.startsWith(" ") || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(.+) -> ([^:]+):$/);
    if (!match) {
      continue;
    }

    const officialEntry = `${match[1].replace(/\./g, "/")}.class`;
    const obfuscatedEntry = `${match[2].replace(/\./g, "/")}.class`;
    classMappings.set(officialEntry, obfuscatedEntry);
  }
  return classMappings;
}

function remapCandidates(
  candidates: string[],
  classMappings: Map<string, string>,
): string[] {
  return candidates.map((candidate) => classMappings.get(candidate) ?? candidate);
}

function pickJarEntry(entries: string[], candidates: string[]): string | null {
  const entrySet = new Set(entries);
  for (const candidate of candidates) {
    if (entrySet.has(candidate)) {
      return candidate;
    }
  }

  const suffix = `/${path.basename(candidates[0] ?? "")}`;
  const suffixMatch = entries.find((entry) => entry.endsWith(suffix));
  return suffixMatch ?? null;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(values[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function resolveVersionSource(
  options: Required<
    Pick<
      MinecraftSourceOptions,
      "versionManifestUrl" | "fabricManifestBaseUrl" | "preferFabricUnobfuscated"
    >
  > & { version: string | null },
): Promise<{
  selectedVersion: string;
  displayVersion: string;
  manifestUrl: string;
  manifest: MinecraftVersionManifest;
  provider: MinecraftSourceProvider;
}> {
  const manifestList = await fetchJson<MinecraftVersionManifestList>(
    options.versionManifestUrl,
  );
  const requested = (options.version ?? manifestList.latest.release).trim();
  const mojangVersionId = requested.endsWith("_unobfuscated")
    ? requested.replace(/_unobfuscated$/, "")
    : requested;
  const mojangVersionEntry = manifestList.versions.find(
    (entry) => entry.id === mojangVersionId,
  );

  const candidates: Array<{
    selectedVersion: string;
    displayVersion: string;
    manifestUrl: string;
    provider: MinecraftSourceProvider;
  }> = [];

  if (requested.endsWith("_unobfuscated")) {
    candidates.push({
      selectedVersion: requested,
      displayVersion: mojangVersionId,
      manifestUrl: toFabricManifestUrl(requested, options.fabricManifestBaseUrl),
      provider: "fabric_unobfuscated",
    });
  } else if (options.preferFabricUnobfuscated) {
    const unobfuscatedVersion = `${mojangVersionId}_unobfuscated`;
    candidates.push({
      selectedVersion: unobfuscatedVersion,
      displayVersion: mojangVersionId,
      manifestUrl: toFabricManifestUrl(unobfuscatedVersion, options.fabricManifestBaseUrl),
      provider: "fabric_unobfuscated",
    });
  }

  if (mojangVersionEntry) {
    candidates.push({
      selectedVersion: mojangVersionEntry.id,
      displayVersion: mojangVersionEntry.id,
      manifestUrl: mojangVersionEntry.url,
      provider: "mojang",
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not resolve Minecraft version '${requested}' from ${options.versionManifestUrl}`,
    );
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const manifest = await fetchJsonOptional<MinecraftVersionManifest>(
        candidate.manifestUrl,
      );
      if (!manifest) {
        continue;
      }
      return { ...candidate, manifest };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    `Unable to resolve Minecraft version '${requested}'. Tried ${candidates.map((candidate) => candidate.manifestUrl).join(", ")}`,
  );
}

async function ensureDownloadedFile(input: {
  label: string;
  url: string;
  destinationPath: string;
  sha1?: string;
  logger: Pick<Console, "log">;
}): Promise<{ path: string; url: string; sha1: string | null }> {
  const expectedSha1 = input.sha1?.toLowerCase() ?? null;
  let shouldDownload = !(await pathExists(input.destinationPath));

  if (!shouldDownload && expectedSha1) {
    const actualSha1 = (await sha1File(input.destinationPath)).toLowerCase();
    shouldDownload = actualSha1 !== expectedSha1;
  }

  if (shouldDownload) {
    input.logger.log(`Downloading ${input.label}...`);
    await downloadFile(input.url, input.destinationPath);
  }

  return {
    path: input.destinationPath,
    url: input.url,
    sha1: expectedSha1,
  };
}

async function ensureCfrJar(options: {
  toolCacheRoot: string;
  cfrVersion: string;
  cfrJarUrl: string;
  cfrJarPath?: string;
  logger: Pick<Console, "log">;
}): Promise<string> {
  if (options.cfrJarPath) {
    if (!(await pathExists(options.cfrJarPath))) {
      throw new Error(`Configured CFR jar does not exist: ${options.cfrJarPath}`);
    }
    return options.cfrJarPath;
  }

  const cfrJarPath = path.join(options.toolCacheRoot, `cfr-${options.cfrVersion}.jar`);
  await ensureDownloadedFile({
    label: `CFR ${options.cfrVersion}`,
    url: options.cfrJarUrl,
    destinationPath: cfrJarPath,
    logger: options.logger,
  });
  return cfrJarPath;
}

async function decompileClass(input: {
  id: string;
  requestedCandidates: string[];
  jarPath: string;
  classEntry: string;
  cfrJarPath: string;
  versionRoot: string;
  obfuscationPath: string | null;
  force: boolean;
}): Promise<DecompiledMinecraftClass> {
  const extractedRoot = path.join(input.versionRoot, "classes");
  const decompiledRoot = path.join(input.versionRoot, "decompiled");
  const extractedClassPath = path.join(extractedRoot, input.classEntry);
  const javaPath = path.join(decompiledRoot, input.classEntry.replace(/\.class$/, ".java"));

  if (!input.force && (await pathExists(javaPath))) {
    return {
      id: input.id,
      requestedCandidates: input.requestedCandidates,
      classEntry: input.classEntry,
      javaPath,
      javaSource: await readFile(javaPath, "utf8"),
    };
  }

  await mkdir(extractedRoot, { recursive: true });
  await mkdir(decompiledRoot, { recursive: true });
  await rm(extractedClassPath, { force: true });
  await runExec("jar", ["xf", input.jarPath, input.classEntry], { cwd: extractedRoot });

  await runExec(
    "java",
    [
      "-jar",
      input.cfrJarPath,
      extractedClassPath,
      "--outputdir",
      decompiledRoot,
      "--extraclasspath",
      input.jarPath,
      "--silent",
      "true",
      "--comments",
      "false",
      ...(input.obfuscationPath ? ["--obfuscationpath", input.obfuscationPath] : []),
    ],
    { cwd: input.versionRoot },
  );

  if (!(await pathExists(javaPath))) {
    throw new Error(`Decompiler did not produce expected source file: ${javaPath}`);
  }

  return {
    id: input.id,
    requestedCandidates: input.requestedCandidates,
    classEntry: input.classEntry,
    javaPath,
    javaSource: await readFile(javaPath, "utf8"),
  };
}

async function ensureAssetsExtracted(input: {
  jarPath: string;
  versionRoot: string;
}): Promise<string> {
  const assetsRoot = path.join(input.versionRoot, "assets-extracted");
  const minecraftAssetsRoot = path.join(assetsRoot, "assets/minecraft");

  if (await pathExists(minecraftAssetsRoot)) {
    return assetsRoot;
  }

  await mkdir(assetsRoot, { recursive: true });
  await runExec("jar", ["xf", input.jarPath, "assets", "data"], {
    cwd: assetsRoot,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (!(await pathExists(minecraftAssetsRoot))) {
    throw new Error(`Assets were extracted, but assets/minecraft was not found in ${assetsRoot}`);
  }

  return assetsRoot;
}

async function ensureServerDataExtracted(input: {
  jarPath: string;
  versionRoot: string;
}): Promise<string> {
  const serverDataRoot = path.join(input.versionRoot, "server-data-extracted");
  const minecraftDataRoot = path.join(serverDataRoot, "data/minecraft");

  if (await pathExists(minecraftDataRoot)) {
    return serverDataRoot;
  }

  await mkdir(serverDataRoot, { recursive: true });
  await runExec("jar", ["xf", input.jarPath, "data"], {
    cwd: serverDataRoot,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (await pathExists(minecraftDataRoot)) {
    return serverDataRoot;
  }

  const nestedServerJar = (await runExec("jar", ["tf", input.jarPath], {
    maxBuffer: 256 * 1024 * 1024,
  }))
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^META-INF\/versions\/[^/]+\/server-[^/]+\.jar$/.test(entry));

  if (nestedServerJar) {
    await runExec("jar", ["xf", input.jarPath, nestedServerJar], {
      cwd: serverDataRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    await runExec("jar", ["xf", path.join(serverDataRoot, nestedServerJar), "data"], {
      cwd: serverDataRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
  }

  if (!(await pathExists(minecraftDataRoot))) {
    throw new Error(`Server data was extracted, but data/minecraft was not found in ${serverDataRoot}`);
  }

  return serverDataRoot;
}

export async function prepareMinecraftSourceBundle(
  options: MinecraftSourceOptions = {},
): Promise<MinecraftSourceBundle> {
  const cacheRoot = path.resolve(process.cwd(), options.cacheRoot ?? DEFAULT_CACHE_ROOT);
  const toolCacheRoot = path.resolve(
    process.cwd(),
    options.toolCacheRoot ?? path.join(cacheRoot, "tools"),
  );
  const cfrVersion = options.cfrVersion ?? DEFAULT_CFR_VERSION;
  const cfrJarUrl =
    options.cfrJarUrl ??
    `https://repo1.maven.org/maven2/org/benf/cfr/${cfrVersion}/cfr-${cfrVersion}.jar`;
  const logger = options.logger ?? console;
  const classTargets = options.classTargets ?? DEFAULT_MINECRAFT_CLASS_TARGETS;

  const versionSource = await resolveVersionSource({
    version: options.version ?? process.env.MINECRAFT_VERSION ?? null,
    versionManifestUrl: options.versionManifestUrl ?? DEFAULT_VERSION_MANIFEST_URL,
    fabricManifestBaseUrl: options.fabricManifestBaseUrl ?? DEFAULT_FABRIC_MANIFEST_BASE_URL,
    preferFabricUnobfuscated: options.preferFabricUnobfuscated ?? true,
  });
  const versionRoot = path.join(cacheRoot, sanitizeForPath(versionSource.selectedVersion));
  await mkdir(versionRoot, { recursive: true });

  const clientDownload = versionSource.manifest.downloads?.client;
  if (!clientDownload?.url) {
    throw new Error("Version manifest does not include downloads.client.url");
  }
  const serverDownload = versionSource.manifest.downloads?.server ?? null;

  const clientJar = await ensureDownloadedFile({
    label: "client jar",
    url: clientDownload.url,
    destinationPath: path.join(versionRoot, "client.jar"),
    sha1: clientDownload.sha1,
    logger,
  });
  const serverJar = serverDownload?.url
    ? await ensureDownloadedFile({
      label: "server jar",
      url: serverDownload.url,
      destinationPath: path.join(versionRoot, "server.jar"),
      sha1: serverDownload.sha1,
      logger,
    })
    : null;
  const cfrJarPath = await ensureCfrJar({
    toolCacheRoot,
    cfrVersion,
    cfrJarUrl,
    cfrJarPath: options.cfrJarPath,
    logger,
  });

  logger.log("Inspecting jar entries...");
  const jarEntries = (await runExec("jar", ["tf", clientJar.path], {
    maxBuffer: 256 * 1024 * 1024,
  }))
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  let clientMappingsPath: string | null = null;
  let clientMappingsUrl: string | null = null;
  let clientMappingsSha1: string | null = null;
  let classMappings = new Map<string, string>();

  if (versionSource.provider === "mojang") {
    const mappingsDownload = versionSource.manifest.downloads?.client_mappings;
    if (!mappingsDownload?.url) {
      logger.warn(
        "Version manifest does not include downloads.client_mappings.url; using jar class names as-is.",
      );
    } else {
      const mappings = await ensureDownloadedFile({
        label: "client mappings",
        url: mappingsDownload.url,
        destinationPath: path.join(versionRoot, "client_mappings.txt"),
        sha1: mappingsDownload.sha1,
        logger,
      });
      clientMappingsPath = mappings.path;
      clientMappingsUrl = mappings.url;
      clientMappingsSha1 = mappings.sha1;
      classMappings = parseOfficialClassMappings(await readFile(clientMappingsPath, "utf8"));
    }
  }

  const classEntries = new Map<string, { target: MinecraftClassTarget; classEntry: string }>();
  for (const target of classTargets) {
    const candidates =
      versionSource.provider === "mojang"
        ? remapCandidates(target.candidates, classMappings)
        : target.candidates;
    const classEntry = pickJarEntry(jarEntries, candidates);

    if (!classEntry) {
      if (target.required !== false) {
        throw new Error(
          `Could not find required class target '${target.id}'. Tried: ${candidates.join(", ")}`,
        );
      }
      logger.warn(`Optional class target '${target.id}' was not found.`);
      continue;
    }

    classEntries.set(target.id, { target, classEntry });
  }

  logger.log(
    `Decompiling ${Array.from(classEntries.values())
      .map((entry) => entry.classEntry)
      .join(", ")}...`,
  );
  const decompiledClasses = await Promise.all(
    Array.from(classEntries.values()).map((entry) =>
      decompileClass({
        id: entry.target.id,
        requestedCandidates: entry.target.candidates,
        jarPath: clientJar.path,
        classEntry: entry.classEntry,
        cfrJarPath,
        versionRoot,
        obfuscationPath: clientMappingsPath,
        force: options.forceDecompile ?? false,
      }),
    ),
  );

  const classes: Record<string, DecompiledMinecraftClass | null> = {};
  for (const target of classTargets) {
    classes[target.id] = null;
  }
  for (const decompiledClass of decompiledClasses) {
    classes[decompiledClass.id] = decompiledClass;
  }

  const assetsRoot =
    options.extractAssets === false
      ? null
      : await ensureAssetsExtracted({ jarPath: clientJar.path, versionRoot });
  const serverDataRoot =
    options.extractAssets === false || !serverJar
      ? null
      : await ensureServerDataExtracted({ jarPath: serverJar.path, versionRoot });

  return {
    version: versionSource.selectedVersion,
    displayVersion: versionSource.displayVersion,
    provider: versionSource.provider,
    manifestUrl: versionSource.manifestUrl,
    versionRoot,
    clientJarPath: clientJar.path,
    clientJarUrl: clientJar.url,
    clientJarSha1: clientJar.sha1,
    serverJarPath: serverJar?.path ?? null,
    serverJarUrl: serverJar?.url ?? null,
    serverJarSha1: serverJar?.sha1 ?? null,
    clientMappingsPath,
    clientMappingsUrl,
    clientMappingsSha1,
    cfrJarPath,
    assetsRoot,
    serverDataRoot,
    jarEntries,
    classes,
  };
}

export async function decompileMinecraftClassTargets(
  bundle: MinecraftSourceBundle,
  targets: MinecraftClassTarget[],
  options: DecompileMinecraftClassTargetsOptions = {},
): Promise<Record<string, DecompiledMinecraftClass | null>> {
  let classMappings = new Map<string, string>();
  if (bundle.provider === "mojang") {
    if (bundle.clientMappingsPath) {
      classMappings = parseOfficialClassMappings(await readFile(bundle.clientMappingsPath, "utf8"));
    }
  }

  const classes: Record<string, DecompiledMinecraftClass | null> = {};
  const decompileJobs: Array<{
    target: MinecraftClassTarget;
    classEntry: string;
  }> = [];

  for (const target of targets) {
    const candidates =
      bundle.provider === "mojang"
        ? remapCandidates(target.candidates, classMappings)
        : target.candidates;
    const classEntry = pickJarEntry(bundle.jarEntries, candidates);

    if (!classEntry) {
      classes[target.id] = null;
      if (target.required !== false) {
        throw new Error(
          `Could not find required class target '${target.id}'. Tried: ${candidates.join(", ")}`,
        );
      }
      options.logger?.warn(`Optional class target '${target.id}' was not found.`);
      continue;
    }

    decompileJobs.push({ target, classEntry });
  }

  const decompiled = await mapWithConcurrency(
    decompileJobs,
    options.concurrency ?? 4,
    (job) => decompileClass({
      id: job.target.id,
      requestedCandidates: job.target.candidates,
      jarPath: bundle.clientJarPath,
      classEntry: job.classEntry,
      cfrJarPath: bundle.cfrJarPath,
      versionRoot: bundle.versionRoot,
      obfuscationPath: bundle.clientMappingsPath,
      force: options.forceDecompile ?? false,
    }),
  );

  for (const decompiledClass of decompiled) {
    classes[decompiledClass.id] = decompiledClass;
  }

  return classes;
}
