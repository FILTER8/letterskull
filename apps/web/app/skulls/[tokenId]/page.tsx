"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { shape } from "wagmi/chains";

import { Button } from "@/components/ui/button";

const LETTER_SKULL_ADDRESS =
  "0x75A9bd203aFbB4D8FB233372d1D9Ea30E0F1Adfd" as const;

const LETTER_SKULL_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "skullTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

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

function openSeaUrlFor(tokenId: string) {
  return `https://opensea.io/assets/shape/${LETTER_SKULL_ADDRESS}/${tokenId}`;
}

async function downloadSvgAsPng(svg: string, filename: string, outPx = 1600) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const svgEl = doc.documentElement;

  svgEl.setAttribute("width", String(outPx));
  svgEl.setAttribute("height", String(outPx));
  svgEl.setAttribute("shape-rendering", "crispEdges");

  const serialized = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    img.decoding = "async";

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load SVG image"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = outPx;
    canvas.height = outPx;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, outPx, outPx);
    ctx.drawImage(img, 0, 0, outPx, outPx);

    const pngUrl = canvas.toDataURL("image/png");

    const a = document.createElement("a");
    a.href = pngUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function SkullDetailPage() {
  const publicClient = usePublicClient({ chainId: shape.id });
  const params = useParams<{ tokenId: string }>();

  const tokenId = params?.tokenId ?? "";
  const isValid = useMemo(() => /^[0-9]+$/.test(tokenId), [tokenId]);

  const [svg, setSvg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchOne = useCallback(async () => {
    if (!publicClient) return;
    if (!isValid) return;

    setLoading(true);
    setErr(null);

    try {
      const uri = (await publicClient.readContract({
        address: LETTER_SKULL_ADDRESS,
        abi: LETTER_SKULL_ABI,
        functionName: "tokenURI",
        args: [BigInt(tokenId)],
      })) as string;

      const parsed = parseTokenUriToSvg(uri);
      setSvg(parsed);
      if (!parsed) setErr("Could not parse on-chain SVG.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load tokenURI");
      setSvg(null);
    } finally {
      setLoading(false);
    }
  }, [publicClient, isValid, tokenId]);

  useEffect(() => {
    fetchOne();
  }, [fetchOne]);

  const os = isValid ? openSeaUrlFor(tokenId) : "#";

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">
            Skull #{tokenId}
          </h1>
          <div className="text-sm text-muted-foreground">
            Fully on-chain SVG • crisp pixel rendering
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/skulls"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
          >
            back to gallery
          </Link>

          <Button
            variant="secondary"
            onClick={() => {
              if (!svg || !isValid) return;
              downloadSvgAsPng(svg, `letterskull-${tokenId}.png`, 1800);
            }}
            disabled={!svg || loading || !isValid}
          >
            Download PNG
          </Button>

          <a href={os} target="_blank" rel="noreferrer">
            <Button variant="secondary" disabled={!isValid}>
              OpenSea
            </Button>
          </a>
        </div>
      </div>

      <div className="flex items-center justify-center">
        {/* no frame/border */}
        <div className="w-full max-w-[720px] aspect-square">
          {loading ? (
            <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : err ? (
            <div className="h-full w-full flex items-center justify-center text-sm text-red-500">
              {err}
            </div>
          ) : svg ? (
            <div
              className="[&>svg]:w-full [&>svg]:h-full"
              style={{ imageRendering: "pixelated" }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
              No SVG
            </div>
          )}
        </div>
      </div>
    </div>
  );
}