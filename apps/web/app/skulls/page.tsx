"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { shape } from "wagmi/chains";

import { Button } from "@/components/ui/button";

const LETTER_SKULL_ADDRESS =
  "0x75A9bd203aFbB4D8FB233372d1D9Ea30E0F1Adfd" as const;

const ZERO = BigInt(0);

const LETTER_SKULL_ABI = [
  {
    type: "function",
    name: "nextTokenId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "skullTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

type SkullItem = {
  tokenId: bigint;
  svg?: string;
  loading: boolean;
  error?: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function decodeBase64ToString(b64: string) {
  const bin = atob(b64);
  const percentEncoded = Array.from(bin)
    .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .join("");
  return decodeURIComponent(percentEncoded);
}

function parseTokenUriToSvg(tokenUri: string): string | null {
  const prefix = "data:application/json;base64,";
  if (!tokenUri.startsWith(prefix)) return null;

  const jsonB64 = tokenUri.slice(prefix.length);
  const jsonStr = decodeBase64ToString(jsonB64);
  const parsed = JSON.parse(jsonStr) as { image?: unknown };

  const image = typeof parsed.image === "string" ? parsed.image : null;
  if (!image) return null;

  const imgPrefix = "data:image/svg+xml;base64,";
  if (image.startsWith(imgPrefix)) {
    const svgB64 = image.slice(imgPrefix.length);
    return decodeBase64ToString(svgB64);
  }

  return null;
}

async function svgToImage(svg: string, px: number): Promise<HTMLImageElement> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const svgEl = doc.documentElement;

  svgEl.setAttribute("width", String(px));
  svgEl.setAttribute("height", String(px));
  svgEl.setAttribute("shape-rendering", "crispEdges");

  const serialized = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load SVG image"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadVisibleSheetPng(opts: {
  svgs: Array<{ tokenId: bigint; svg: string }>;
  tilePx: number;
  gapPx: number;
  cols: number;
  outScale?: number; // upscale (for crispness)
}) {
  const { svgs, tilePx, gapPx, cols, outScale = 2 } = opts;
  if (svgs.length === 0) return;

  const rows = Math.ceil(svgs.length / cols);

  const outTile = tilePx * outScale;
  const outGap = gapPx * outScale;

  const w = cols * outTile + (cols - 1) * outGap;
  const h = rows * outTile + (rows - 1) * outGap;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  // Load images (bounded concurrency-ish)
  const imgs = await Promise.all(
    svgs.map(async ({ svg }) => svgToImage(svg, outTile)),
  );

  imgs.forEach((img, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = c * (outTile + outGap);
    const y = r * (outTile + outGap);
    ctx.drawImage(img, x, y, outTile, outTile);
  });

  const pngUrl = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = pngUrl;
  a.download = `letterskull-gallery-${svgs.length}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function SkullsGalleryPage() {
  const publicClient = usePublicClient({ chainId: shape.id });

  const [mintedCount, setMintedCount] = useState<bigint>(ZERO);
  const [items, setItems] = useState<SkullItem[]>([]);
  const [loadingCount, setLoadingCount] = useState(true);

  // grid sizing
  const [tile, setTile] = useState(140); // visual size
  const gap = 0; // IMPORTANT: pixel-grid look (no gaps)
  const [pageSize] = useState(80);
  const [loaded, setLoaded] = useState(0);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(6);

  const maxToLoad = useMemo(() => {
    const mc = Number(mintedCount);
    if (!Number.isFinite(mc) || mc < 0) return 0;
    return mc;
  }, [mintedCount]);

  const recomputeCols = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const c = Math.max(1, Math.floor((w + gap) / (tile + gap)));
    setCols(c);
  }, [tile, gap]);

  useEffect(() => {
    recomputeCols();
    window.addEventListener("resize", recomputeCols);
    return () => window.removeEventListener("resize", recomputeCols);
  }, [recomputeCols]);

  const fetchMintedCount = useCallback(async () => {
    if (!publicClient) return;
    setLoadingCount(true);
    try {
      const nextTokenId = (await publicClient.readContract({
        address: LETTER_SKULL_ADDRESS,
        abi: LETTER_SKULL_ABI,
        functionName: "nextTokenId",
      })) as bigint;

      setMintedCount(nextTokenId > ZERO ? nextTokenId - BigInt(1) : ZERO);
    } finally {
      setLoadingCount(false);
    }
  }, [publicClient]);

  const loadMore = useCallback(async () => {
    if (!publicClient) return;
    if (loaded >= maxToLoad) return;

    const start = loaded + 1;
    const end = Math.min(loaded + pageSize, maxToLoad);

    const batchTokenIds: bigint[] = [];
    for (let i = start; i <= end; i++) batchTokenIds.push(BigInt(i));

    setItems((prev) => [
      ...prev,
      ...batchTokenIds.map((id) => ({ tokenId: id, loading: true })),
    ]);
    setLoaded(end);

    const results = await Promise.all(
      batchTokenIds.map(async (tokenId) => {
        try {
          const uri = (await publicClient.readContract({
            address: LETTER_SKULL_ADDRESS,
            abi: LETTER_SKULL_ABI,
            functionName: "tokenURI",
            args: [tokenId],
          })) as string;

          const svg = parseTokenUriToSvg(uri);
          return { tokenId, svg: svg ?? undefined, loading: false } as SkullItem;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Failed to load tokenURI";
          return { tokenId, loading: false, error: msg } as SkullItem;
        }
      }),
    );

    setItems((prev) => {
      const map = new Map<string, SkullItem>();
      for (const it of prev) map.set(it.tokenId.toString(), it);
      for (const r of results) map.set(r.tokenId.toString(), r);
      return Array.from(map.values()).sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
    });
  }, [publicClient, loaded, maxToLoad, pageSize]);

  useEffect(() => {
    fetchMintedCount();
  }, [fetchMintedCount]);

  useEffect(() => {
    if (!loadingCount && mintedCount > ZERO && items.length === 0) loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingCount, mintedCount]);

  const canLoadMore = loaded < maxToLoad;

  const downloadableVisible = useMemo(() => {
    // only those currently loaded with svg (visible in the grid)
    return items
      .filter((x) => !x.loading && !!x.svg)
      .map((x) => ({ tokenId: x.tokenId, svg: x.svg! }));
  }, [items]);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
              Skull Gallery
            </h1>

            {/* size controls near headline */}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                className="h-9 px-3"
                onClick={() => setTile((t) => clamp(t - 16, 64, 260))}
                aria-label="Decrease tile size"
              >
                −
              </Button>
              <div className="text-sm text-muted-foreground w-[64px] text-center">
                {tile}px
              </div>
              <Button
                variant="secondary"
                className="h-9 px-3"
                onClick={() => setTile((t) => clamp(t + 16, 64, 260))}
                aria-label="Increase tile size"
              >
                +
              </Button>
            </div>

            <Button
              variant="secondary"
              className="h-9"
              onClick={() =>
                downloadVisibleSheetPng({
                  svgs: downloadableVisible,
                  tilePx: tile,
                  gapPx: gap,
                  cols,
                  outScale: 3, // crisp
                })
              }
              disabled={downloadableVisible.length === 0}
              title="Download all currently loaded skulls as one PNG sheet"
            >
              Download sheet PNG
            </Button>

            <Link
              href="/"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
            >
              back to mint
            </Link>
          </div>

          <div className="text-sm text-muted-foreground">
            {loadingCount ? (
              <>Loading supply…</>
            ) : (
              <>
                Minted Skulls: <b>{mintedCount.toString()}</b> • Loaded:{" "}
                <b>{items.filter((x) => !x.loading && x.svg).length}</b>
              </>
            )}
          </div>
        </div>

        <div className="text-sm text-muted-foreground">
          Click to open • Download sheet to share
        </div>
      </div>

      {/* Pixel grid */}
      <div ref={gridRef}>
        <div
          className="grid"
          style={{
            gap: `${gap}px`,
            gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))`,
          }}
        >
          {items.map((it) => {
            const href = `/skulls/${it.tokenId.toString()}`;

            return (
              <Link
                key={it.tokenId.toString()}
                href={href}
                className="block aspect-square"
                title={`Skull #${it.tokenId.toString()}`}
              >
                {/* No frame, no border, no rounding — pure pixel grid */}
                <div className="aspect-square w-full">
                  {it.loading ? (
                    <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground">
                      …
                    </div>
                  ) : it.error ? (
                    <div className="h-full w-full flex items-center justify-center text-xs text-red-500">
                      !
                    </div>
                  ) : it.svg ? (
                    <div
                      className="[&>svg]:w-full [&>svg]:h-full"
                      style={{ imageRendering: "pixelated" }}
                      dangerouslySetInnerHTML={{ __html: it.svg }}
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground">
                      ?
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Load more */}
      <div className="flex justify-center pt-2">
        <Button onClick={loadMore} disabled={!publicClient || !canLoadMore} variant="secondary">
          {canLoadMore ? "Load more" : "All loaded"}
        </Button>
      </div>
    </div>
  );
}