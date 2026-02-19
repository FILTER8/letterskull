import { NextRequest, NextResponse } from "next/server";
import { Alchemy, Network } from "alchemy-sdk";
import { Address, isAddress } from "viem";
import { z } from "zod";
import { config } from "@/lib/config";

const LETTER_CONTRACT_ADDRESS = "0xb8261f4431928F176c5A07887c8fcAcCd13c6D16" as const;

// Force Shape mainnet
const alchemyMainnet = new Alchemy({
  apiKey: config.alchemyKey,
  network: Network.SHAPE_MAINNET,
});

const schema = z.object({
  address: z.string().refine((val) => isAddress(val), {
    message: "Invalid Ethereum address format",
  }),
});

// normalize tokenId to decimal string
function parseAlchemyTokenIdToDecimal(tokenId: string): string {
  const t = tokenId.trim();
  if (t.startsWith("0x")) return BigInt(t).toString();
  if (/^[0-9a-fA-F]+$/.test(t) && /[a-fA-F]/.test(t)) return BigInt("0x" + t).toString();
  return BigInt(t).toString();
}

type LetterItem = {
  tokenId: string; // decimal string
  name?: string | null;
  imageUrl?: string | null;
  tokenUri?: string | null;
};

function toErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Alchemy SDK typings vary by version.
// We safely extract tokenUri from multiple possible shapes WITHOUT using `any`.
function extractTokenUri(md: unknown): string | null {
  if (typeof md !== "object" || md === null) return null;

  // md.tokenUri could be string OR { raw: string } OR something else
  const tokenUriVal = (md as Record<string, unknown>)["tokenUri"];
  if (typeof tokenUriVal === "string") return tokenUriVal;

  if (typeof tokenUriVal === "object" && tokenUriVal !== null) {
    const raw = (tokenUriVal as Record<string, unknown>)["raw"];
    if (typeof raw === "string") return raw;
  }

  // sometimes md.raw?.tokenUri exists
  const rawObj = (md as Record<string, unknown>)["raw"];
  if (typeof rawObj === "object" && rawObj !== null) {
    const rawTokenUri = (rawObj as Record<string, unknown>)["tokenUri"];
    if (typeof rawTokenUri === "string") return rawTokenUri;
  }

  return null;
}

function extractImageUrl(md: unknown): string | null {
  if (typeof md !== "object" || md === null) return null;

  const image = (md as Record<string, unknown>)["image"];
  if (typeof image === "object" && image !== null) {
    const pngUrl = (image as Record<string, unknown>)["pngUrl"];
    const cachedUrl = (image as Record<string, unknown>)["cachedUrl"];
    const originalUrl = (image as Record<string, unknown>)["originalUrl"];
    if (typeof pngUrl === "string") return pngUrl;
    if (typeof cachedUrl === "string") return cachedUrl;
    if (typeof originalUrl === "string") return originalUrl;
  }

  const rawObj = (md as Record<string, unknown>)["raw"];
  if (typeof rawObj === "object" && rawObj !== null) {
    const rawMd = (rawObj as Record<string, unknown>)["metadata"];
    if (typeof rawMd === "object" && rawMd !== null) {
      const rawImage = (rawMd as Record<string, unknown>)["image"];
      if (typeof rawImage === "string") return rawImage;
    }
  }

  return null;
}

function extractName(md: unknown): string | null {
  if (typeof md !== "object" || md === null) return null;

  const name = (md as Record<string, unknown>)["name"];
  if (typeof name === "string") return name;

  const rawObj = (md as Record<string, unknown>)["raw"];
  if (typeof rawObj === "object" && rawObj !== null) {
    const rawMd = (rawObj as Record<string, unknown>)["metadata"];
    if (typeof rawMd === "object" && rawMd !== null) {
      const rawName = (rawMd as Record<string, unknown>)["name"];
      if (typeof rawName === "string") return rawName;
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    const validation = schema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validation.error.issues },
        { status: 400 }
      );
    }

    const { address } = validation.data;

    // 1) get owned tokenIds (fast)
    const owned = await alchemyMainnet.nft.getNftsForOwner(address as Address, {
      contractAddresses: [LETTER_CONTRACT_ADDRESS as Address],
      omitMetadata: true,
    });

    const tokenIds = owned.ownedNfts
      .map((n) => parseAlchemyTokenIdToDecimal(n.tokenId))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

    // 2) fetch metadata for each tokenId
    const letters: LetterItem[] = await Promise.all(
      tokenIds.map(async (tokenIdDec) => {
        try {
          // SDK accepts tokenId as string; decimal works.
          const md = await alchemyMainnet.nft.getNftMetadata(
            LETTER_CONTRACT_ADDRESS,
            tokenIdDec,
            { refreshCache: false }
          );

          const imageUrl = extractImageUrl(md);
          const name = extractName(md);
          const tokenUri = extractTokenUri(md);

          return {
            tokenId: tokenIdDec,
            name,
            imageUrl,
            tokenUri,
          };
        } catch {
          return { tokenId: tokenIdDec, name: null, imageUrl: null, tokenUri: null };
        }
      })
    );

    return NextResponse.json({
      success: true,
      address,
      letterContract: LETTER_CONTRACT_ADDRESS,
      letters,
    });
  } catch (err: unknown) {
    console.error("Error fetching NFTs:", err);
    return NextResponse.json(
      { error: "Failed to fetch NFTs", details: toErrorMessage(err) },
      { status: 500 }
    );
  }
}
