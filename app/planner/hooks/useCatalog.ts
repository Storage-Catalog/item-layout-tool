import { useEffect, useState } from "react";
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

function getCatalogCandidateUrls(): string[] {
  return Array.from(
    new Set([
      withBasePath("/items/items.json"),
      "/items/items.json",
    ]),
  );
}

export function useCatalog(): {
  catalogItems: CatalogItem[];
  catalogGameVersion: string | null;
  isLoadingCatalog: boolean;
  catalogError: string | null;
} {
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogGameVersion, setCatalogGameVersion] = useState<string | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog(): Promise<void> {
      try {
        setIsLoadingCatalog(true);
        setCatalogError(null);

        let response: Response | null = null;

        for (const url of getCatalogCandidateUrls()) {
          const attempt = await fetch(url);
          if (attempt.ok) {
            response = attempt;
            break;
          }
        }

        if (!response) {
          throw new Error("Failed to load item catalog from known paths");
        }

        const parsed: unknown = await response.json();
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
        const rawGameVersion = (parsed as CatalogResponse).gameVersion;
        const gameVersion = typeof rawGameVersion === "string" ? rawGameVersion : null;

        if (!cancelled) {
          setCatalogItems(items);
          setCatalogGameVersion(gameVersion);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Unknown catalog loading error";
          setCatalogError(message);
          setCatalogGameVersion(null);
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
  }, []);

  return {
    catalogItems,
    catalogGameVersion,
    isLoadingCatalog,
    catalogError,
  };
}
