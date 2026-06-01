import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BLOCKS_CLASS_CANDIDATES,
  CACHE_ROOT,
  CREATIVE_MODE_TABS_CLASS_CANDIDATES,
  CFR_JAR_PATH_OVERRIDE,
  CFR_JAR_URL,
  CFR_VERSION,
  FOODS_CLASS_CANDIDATES,
  ITEM_CLASS_CANDIDATES,
  LOCAL_BLOCKS_JAVA_PATH,
  LOCAL_CREATIVE_MODE_TABS_JAVA_PATH,
  LOCAL_FOODS_JAVA_PATH,
  LOCAL_ITEMS_JAVA_PATH,
  LOCAL_VANILLA_BLOCK_LOOT_JAVA_PATH,
  TOOL_CACHE_ROOT,
  VANILLA_BLOCK_LOOT_CLASS_CANDIDATES,
  VERSION_MANIFEST_URL,
  sanitizeForPath,
  toFabricManifestUrl,
} from "./config";
import type {
  LoadedJavaSources,
  VersionManifest,
  VersionManifestList,
} from "./types";
import {
  downloadFile,
  fetchJson,
  fetchJsonOptional,
  pathExists,
  runExec,
  sha1File,
} from "./utils";

function pickJarEntry(entries: string[], candidates: string[]): string | null {
  const set = new Set(entries);
  for (const candidate of candidates) {
    if (set.has(candidate)) {
      return candidate;
    }
  }

  const suffix = `/${path.basename(candidates[0] ?? "")}`;
  const bySuffix = entries.filter((entry) => entry.endsWith(suffix));
  return bySuffix.length > 0 ? bySuffix[0] : null;
}

async function ensureCfrJar(): Promise<string> {
  if (CFR_JAR_PATH_OVERRIDE) {
    if (!(await pathExists(CFR_JAR_PATH_OVERRIDE))) {
      throw new Error(`Configured ITEMFETCH_CFR_JAR_PATH does not exist: ${CFR_JAR_PATH_OVERRIDE}`);
    }
    return CFR_JAR_PATH_OVERRIDE;
  }

  const cfrJarPath = path.join(TOOL_CACHE_ROOT, `cfr-${CFR_VERSION}.jar`);
  if (!(await pathExists(cfrJarPath))) {
    console.log(`Downloading CFR ${CFR_VERSION}...`);
    await mkdir(path.dirname(cfrJarPath), { recursive: true });
    await downloadFile(CFR_JAR_URL, cfrJarPath);
  }
  return cfrJarPath;
}

async function resolveVersionSource(): Promise<{
  selectedVersion: string;
  manifestUrl: string;
  manifest: VersionManifest;
  source: "fabric_unobfuscated" | "mojang";
}> {
  const manifestList = await fetchJson<VersionManifestList>(VERSION_MANIFEST_URL);

  const requested = (
    process.env.ITEMFETCH_GAME_VERSION ??
    process.env.MINECRAFT_VERSION ??
    manifestList.latest.release
  ).trim();
  const mojangVersionId = requested.endsWith("_unobfuscated")
    ? requested.replace(/_unobfuscated$/, "")
    : requested;
  const mojangVersionEntry = manifestList.versions.find(
    (entry) => entry.id === mojangVersionId,
  );

  const candidates: Array<{
    source: "fabric_unobfuscated" | "mojang";
    selectedVersion: string;
    manifestUrl: string;
  }> = [];

  const preferFabricUnobfuscated = process.env.ITEMFETCH_PREFER_UNOBF !== "0";
  if (requested.endsWith("_unobfuscated")) {
    candidates.push({
      source: "fabric_unobfuscated",
      selectedVersion: requested,
      manifestUrl: toFabricManifestUrl(requested),
    });
  } else if (preferFabricUnobfuscated) {
    const unobfVersion = `${mojangVersionId}_unobfuscated`;
    candidates.push({
      source: "fabric_unobfuscated",
      selectedVersion: unobfVersion,
      manifestUrl: toFabricManifestUrl(unobfVersion),
    });
  }

  if (mojangVersionEntry) {
    candidates.push({
      source: "mojang",
      selectedVersion: mojangVersionEntry.id,
      manifestUrl: mojangVersionEntry.url,
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not resolve version '${requested}' in Mojang manifest (${VERSION_MANIFEST_URL})`,
    );
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const manifest = await fetchJsonOptional<VersionManifest>(candidate.manifestUrl);
      if (!manifest) {
        continue;
      }

      return {
        selectedVersion: candidate.selectedVersion,
        manifestUrl: candidate.manifestUrl,
        manifest,
        source: candidate.source,
      };
    } catch (error) {
      if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    `Unable to resolve version manifest for '${requested}'. Tried: ${candidates.map((c) => c.manifestUrl).join(", ")}`,
  );
}

async function ensureClientJar(
  versionRoot: string,
  manifest: VersionManifest,
): Promise<{ jarPath: string; jarUrl: string; jarSha1: string | null }> {
  const clientDownload = manifest.downloads?.client;
  if (!clientDownload?.url) {
    throw new Error("Version manifest does not include downloads.client.url");
  }

  const jarPath = path.join(versionRoot, "client.jar");
  const expectedSha1 = clientDownload.sha1?.toLowerCase() ?? null;
  let shouldDownload = !(await pathExists(jarPath));

  if (!shouldDownload && expectedSha1) {
    const actualSha1 = (await sha1File(jarPath)).toLowerCase();
    if (actualSha1 !== expectedSha1) {
      shouldDownload = true;
    }
  }

  if (shouldDownload) {
    console.log(`Downloading client jar...`);
    await downloadFile(clientDownload.url, jarPath);
  }

  return {
    jarPath,
    jarUrl: clientDownload.url,
    jarSha1: expectedSha1,
  };
}

async function ensureClientMappings(
  versionRoot: string,
  manifest: VersionManifest,
): Promise<{ mappingsPath: string; mappingsUrl: string; mappingsSha1: string | null }> {
  const clientMappingsDownload = manifest.downloads?.client_mappings;
  if (!clientMappingsDownload?.url) {
    throw new Error("Mojang client jar requires downloads.client_mappings.url for named decompilation");
  }

  const mappingsPath = path.join(versionRoot, "client_mappings.txt");
  const expectedSha1 = clientMappingsDownload.sha1?.toLowerCase() ?? null;
  let shouldDownload = !(await pathExists(mappingsPath));

  if (!shouldDownload && expectedSha1) {
    const actualSha1 = (await sha1File(mappingsPath)).toLowerCase();
    if (actualSha1 !== expectedSha1) {
      shouldDownload = true;
    }
  }

  if (shouldDownload) {
    console.log(`Downloading client mappings...`);
    await downloadFile(clientMappingsDownload.url, mappingsPath);
  }

  return {
    mappingsPath,
    mappingsUrl: clientMappingsDownload.url,
    mappingsSha1: expectedSha1,
  };
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

function remapClassCandidates(
  candidates: string[],
  classMappings: Map<string, string>,
): string[] {
  return candidates.map((candidate) => classMappings.get(candidate) ?? candidate);
}

async function decompileClass(
  jarPath: string,
  classEntry: string,
  cfrJarPath: string,
  workingRoot: string,
  obfuscationPath: string | null,
): Promise<{ javaPath: string; javaSource: string }> {
  const extractedRoot = path.join(workingRoot, "classes");
  const decompiledRoot = path.join(workingRoot, "decompiled");
  await mkdir(extractedRoot, { recursive: true });
  await mkdir(decompiledRoot, { recursive: true });

  const extractedClassPath = path.join(extractedRoot, classEntry);
  await rm(extractedClassPath, { force: true });

  await runExec("jar", ["xf", jarPath, classEntry], { cwd: extractedRoot });

  await runExec(
    "java",
    [
      "-jar",
      cfrJarPath,
      extractedClassPath,
      "--outputdir",
      decompiledRoot,
      "--extraclasspath",
      jarPath,
      "--silent",
      "true",
      "--comments",
      "false",
      ...(obfuscationPath ? ["--obfuscationpath", obfuscationPath] : []),
    ],
    { cwd: workingRoot },
  );

  const javaPath = path.join(decompiledRoot, classEntry.replace(/\.class$/, ".java"));
  if (!(await pathExists(javaPath))) {
    throw new Error(`Decompiler did not produce expected source file: ${javaPath}`);
  }

  const javaSource = await readFile(javaPath, "utf8");
  return { javaPath, javaSource };
}

export async function loadJavaSources(): Promise<LoadedJavaSources> {
  if (Boolean(LOCAL_ITEMS_JAVA_PATH) !== Boolean(LOCAL_BLOCKS_JAVA_PATH)) {
    throw new Error(
      "If using local sources, set both ITEMFETCH_ITEMS_JAVA_PATH and ITEMFETCH_BLOCKS_JAVA_PATH.",
    );
  }

  if (LOCAL_ITEMS_JAVA_PATH && LOCAL_BLOCKS_JAVA_PATH) {
    console.log(`Using local Java files: ${LOCAL_ITEMS_JAVA_PATH}, ${LOCAL_BLOCKS_JAVA_PATH}`);
    const [itemsJavaSource, blocksJavaSource, foodsJavaSource, creativeModeTabsJavaSource, vanillaBlockLootJavaSource] =
      await Promise.all([
      readFile(LOCAL_ITEMS_JAVA_PATH, "utf8"),
      readFile(LOCAL_BLOCKS_JAVA_PATH, "utf8"),
      LOCAL_FOODS_JAVA_PATH ? readFile(LOCAL_FOODS_JAVA_PATH, "utf8") : Promise.resolve(null),
      LOCAL_CREATIVE_MODE_TABS_JAVA_PATH
        ? readFile(LOCAL_CREATIVE_MODE_TABS_JAVA_PATH, "utf8")
        : Promise.resolve(null),
      LOCAL_VANILLA_BLOCK_LOOT_JAVA_PATH
        ? readFile(LOCAL_VANILLA_BLOCK_LOOT_JAVA_PATH, "utf8")
        : Promise.resolve(null),
    ]);
    return {
      itemsJavaSource,
      blocksJavaSource,
      foodsJavaSource,
      creativeModeTabsJavaSource,
      vanillaBlockLootJavaSource,
      jarPath: null,
      cacheVersionRoot: null,
      minecraftVersion: null,
      sourceInfo: {
        mode: "local-java",
        itemsJavaPath: LOCAL_ITEMS_JAVA_PATH,
        blocksJavaPath: LOCAL_BLOCKS_JAVA_PATH,
        foodsJavaPath: LOCAL_FOODS_JAVA_PATH,
        creativeModeTabsJavaPath: LOCAL_CREATIVE_MODE_TABS_JAVA_PATH,
        vanillaBlockLootJavaPath: LOCAL_VANILLA_BLOCK_LOOT_JAVA_PATH,
      },
    };
  }

  const versionSource = await resolveVersionSource();
  const cacheVersionName = sanitizeForPath(versionSource.selectedVersion);
  const versionRoot = path.join(CACHE_ROOT, cacheVersionName);
  await mkdir(versionRoot, { recursive: true });

  const { jarPath, jarUrl, jarSha1 } = await ensureClientJar(versionRoot, versionSource.manifest);
  const cfrJarPath = await ensureCfrJar();
  let clientMappingsPath: string | null = null;
  let clientMappingsUrl: string | null = null;
  let clientMappingsSha1: string | null = null;

  console.log(`Inspecting jar entries...`);
  const jarEntriesText = await runExec("jar", ["tf", jarPath], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const jarEntries = jarEntriesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let itemsClassCandidates = ITEM_CLASS_CANDIDATES;
  let blocksClassCandidates = BLOCKS_CLASS_CANDIDATES;
  let foodsClassCandidates = FOODS_CLASS_CANDIDATES;
  let creativeModeTabsClassCandidates = CREATIVE_MODE_TABS_CLASS_CANDIDATES;
  let vanillaBlockLootClassCandidates = VANILLA_BLOCK_LOOT_CLASS_CANDIDATES;

  let itemsClassEntry = pickJarEntry(jarEntries, itemsClassCandidates);
  let blocksClassEntry = pickJarEntry(jarEntries, blocksClassCandidates);
  let foodsClassEntry = pickJarEntry(jarEntries, foodsClassCandidates);
  let creativeModeTabsClassEntry = pickJarEntry(jarEntries, creativeModeTabsClassCandidates);
  let vanillaBlockLootClassEntry = pickJarEntry(jarEntries, vanillaBlockLootClassCandidates);

  if (
    versionSource.source === "mojang" &&
    (!itemsClassEntry || !blocksClassEntry || !foodsClassEntry || !creativeModeTabsClassEntry)
  ) {
    const clientMappings = await ensureClientMappings(versionRoot, versionSource.manifest);
    clientMappingsPath = clientMappings.mappingsPath;
    clientMappingsUrl = clientMappings.mappingsUrl;
    clientMappingsSha1 = clientMappings.mappingsSha1;
    const classMappings = parseOfficialClassMappings(await readFile(clientMappingsPath, "utf8"));

    itemsClassCandidates = remapClassCandidates(ITEM_CLASS_CANDIDATES, classMappings);
    blocksClassCandidates = remapClassCandidates(BLOCKS_CLASS_CANDIDATES, classMappings);
    foodsClassCandidates = remapClassCandidates(FOODS_CLASS_CANDIDATES, classMappings);
    creativeModeTabsClassCandidates = remapClassCandidates(
      CREATIVE_MODE_TABS_CLASS_CANDIDATES,
      classMappings,
    );
    vanillaBlockLootClassCandidates = remapClassCandidates(
      VANILLA_BLOCK_LOOT_CLASS_CANDIDATES,
      classMappings,
    );

    itemsClassEntry = pickJarEntry(jarEntries, itemsClassCandidates);
    blocksClassEntry = pickJarEntry(jarEntries, blocksClassCandidates);
    foodsClassEntry = pickJarEntry(jarEntries, foodsClassCandidates);
    creativeModeTabsClassEntry = pickJarEntry(jarEntries, creativeModeTabsClassCandidates);
    vanillaBlockLootClassEntry = pickJarEntry(jarEntries, vanillaBlockLootClassCandidates);
  }

  if (!itemsClassEntry || !blocksClassEntry || !foodsClassEntry || !creativeModeTabsClassEntry) {
    throw new Error(
      `Could not find required class entries in jar. Items=${itemsClassEntry ?? "missing"}, Blocks=${blocksClassEntry ?? "missing"}, Foods=${foodsClassEntry ?? "missing"}, CreativeModeTabs=${creativeModeTabsClassEntry ?? "missing"}.`,
    );
  }

  if (!vanillaBlockLootClassEntry) {
    console.warn("VanillaBlockLoot class not found in jar; block loot method data will be unavailable.");
  }

  console.log(
    `Decompiling ${itemsClassEntry}, ${blocksClassEntry}, ${foodsClassEntry}, ${creativeModeTabsClassEntry}${vanillaBlockLootClassEntry ? `, and ${vanillaBlockLootClassEntry}` : ""}...`,
  );
  const [itemsResult, blocksResult, foodsResult, creativeModeTabsResult, vanillaBlockLootResult] =
    await Promise.all([
      decompileClass(jarPath, itemsClassEntry, cfrJarPath, versionRoot, clientMappingsPath),
      decompileClass(jarPath, blocksClassEntry, cfrJarPath, versionRoot, clientMappingsPath),
      decompileClass(jarPath, foodsClassEntry, cfrJarPath, versionRoot, clientMappingsPath),
      decompileClass(
        jarPath,
        creativeModeTabsClassEntry,
        cfrJarPath,
        versionRoot,
        clientMappingsPath,
      ),
      vanillaBlockLootClassEntry
        ? decompileClass(
            jarPath,
            vanillaBlockLootClassEntry,
            cfrJarPath,
            versionRoot,
            clientMappingsPath,
          )
        : Promise.resolve(null),
    ]);

  return {
    itemsJavaSource: itemsResult.javaSource,
    blocksJavaSource: blocksResult.javaSource,
    foodsJavaSource: foodsResult.javaSource,
    creativeModeTabsJavaSource: creativeModeTabsResult.javaSource,
    vanillaBlockLootJavaSource: vanillaBlockLootResult?.javaSource ?? null,
    jarPath,
    cacheVersionRoot: versionRoot,
    minecraftVersion: versionSource.selectedVersion,
    sourceInfo: {
      mode: "decompiled",
      selectedVersion: versionSource.selectedVersion,
      manifestSource: versionSource.source,
      manifestUrl: versionSource.manifestUrl,
      jarUrl,
      jarSha1,
      jarPath,
      clientMappingsUrl,
      clientMappingsSha1,
      clientMappingsPath,
      cfrJarPath,
      itemsClassEntry,
      blocksClassEntry,
      foodsClassEntry,
      creativeModeTabsClassEntry,
      vanillaBlockLootClassEntry: vanillaBlockLootClassEntry ?? null,
      itemsJavaPath: itemsResult.javaPath,
      blocksJavaPath: blocksResult.javaPath,
      foodsJavaPath: foodsResult.javaPath,
      creativeModeTabsJavaPath: creativeModeTabsResult.javaPath,
      vanillaBlockLootJavaPath: vanillaBlockLootResult?.javaPath ?? null,
      tempDirectory: os.tmpdir(),
    },
  };
}
