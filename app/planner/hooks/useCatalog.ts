import { useCallback, useEffect, useState } from "react";
import { withBasePath } from "../base-path";
import type { CatalogItem, CatalogResponse } from "../types";

function parseCreativeTabs(rawCreativeTabs: unknown): string[] {
  if (!Array.isArray(rawCreativeTabs)) {
    return [];
  }
  return rawCreativeTabs.filter((entry): entry is string => typeof entry === "string");
}

function parseRegistration(rawRegistration: unknown): CatalogItem["registration"] {
  if (rawRegistration === "block" || rawRegistration === "item") {
    return rawRegistration;
  }
  return "unknown";
}

function parseMaxStackSize(rawMaxStackSize: unknown): number {
  if (typeof rawMaxStackSize === "number" && Number.isFinite(rawMaxStackSize) && rawMaxStackSize > 0) {
    return Math.floor(rawMaxStackSize);
  }
  return 64;
}

const GAME_VERSION_STORAGE_KEY = "item-layout-tool:game-version";

async function fetchJsonFromCandidates(urlPath: string, description: string): Promise<unknown> {
  for (const url of new Set([withBasePath(urlPath), urlPath])) {
    const attempt = await fetch(url);
    if (attempt.ok) {
      return attempt.json();
    }
  }
  throw new Error(`Failed to load ${description} from known paths`);
}

function readStoredGameVersion(): string | null {
  try {
    return window.localStorage.getItem(GAME_VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeGameVersion(gameVersion: string): void {
  try {
    window.localStorage.setItem(GAME_VERSION_STORAGE_KEY, gameVersion);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts only for this visit.
  }
}

async function loadAvailableGameVersions(): Promise<string[]> {
  const parsed = await fetchJsonFromCandidates("/items/versions.json", "game version list");
  const versions =
    parsed && typeof parsed === "object" && "versions" in parsed ? parsed.versions : null;
  if (!Array.isArray(versions)) {
    throw new Error("Game version list format is invalid");
  }
  const validVersions = versions.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (validVersions.length === 0) {
    throw new Error("Game version list is empty");
  }
  return validVersions;
}

export function useCatalog(): {
  catalogItems: CatalogItem[];
  selectedGameVersion: string | null;
  availableGameVersions: string[];
  selectGameVersion: (gameVersion: string) => void;
  isLoadingCatalog: boolean;
  catalogError: string | null;
} {
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [availableGameVersions, setAvailableGameVersions] = useState<string[]>([]);
  const [selectedGameVersion, setSelectedGameVersion] = useState<string | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadAvailableGameVersions()
      .then((versions) => {
        if (cancelled) {
          return;
        }
        const storedVersion = readStoredGameVersion();
        setAvailableGameVersions(versions);
        setSelectedGameVersion(
          storedVersion && versions.includes(storedVersion) ? storedVersion : versions[0],
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCatalogError(error instanceof Error ? error.message : "Unknown catalog loading error");
          setIsLoadingCatalog(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedGameVersion) {
      return;
    }
    const gameVersion = selectedGameVersion;
    let cancelled = false;

    async function loadCatalog(): Promise<void> {
      try {
        setIsLoadingCatalog(true);
        setCatalogError(null);

        const parsed = await fetchJsonFromCandidates(
          `/items/${encodeURIComponent(gameVersion)}/items.json`,
          `item catalog for Minecraft ${gameVersion}`,
        );
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("items" in parsed) ||
          !Array.isArray((parsed as CatalogResponse).items)
        ) {
          throw new Error("Item catalog format is invalid");
        }

        const items = (parsed as CatalogResponse).items
          .filter(
            (item) => typeof item.id === "string" && typeof item.texturePath === "string",
          )
          .map((item) => ({
            id: item.id,
            texturePath: withBasePath(item.texturePath as string),
            creativeTabs: parseCreativeTabs(item.creativeTabs),
            registration: parseRegistration(item.registration),
            maxStackSize: parseMaxStackSize(item.maxStackSize),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));

        if (!cancelled) {
          setCatalogItems(items);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Unknown catalog loading error";
          setCatalogError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCatalog(false);
        }
      }
    }

    loadCatalog();

    return () => {
      cancelled = true;
    };
  }, [selectedGameVersion]);

  const selectGameVersion = useCallback((gameVersion: string) => {
    storeGameVersion(gameVersion);
    setSelectedGameVersion(gameVersion);
  }, []);

  return {
    catalogItems,
    selectedGameVersion,
    availableGameVersions,
    selectGameVersion,
    isLoadingCatalog,
    catalogError,
  };
}
