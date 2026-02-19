"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { shape } from "wagmi/chains";
import { parseEther } from "viem";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const ZERO = BigInt(0);

const LETTER_SKULL_ADDRESS =
  "0x75A9bd203aFbB4D8FB233372d1D9Ea30E0F1Adfd" as const;

const LETTER_SKULL_ABI = [
  {
    type: "function",
    name: "skullOfLetter",
    stateMutability: "view",
    inputs: [{ name: "letterTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "usedLetterToken",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "nonceOf",
    stateMutability: "view",
    inputs: [{ name: "skullTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewSvg",
    stateMutability: "pure",
    inputs: [
      { name: "letterTokenId", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{ name: "letterTokenId", type: "uint256" }],
    outputs: [{ name: "skullTokenId", type: "uint256" }],
  },
] as const;

type Item = {
  letterTokenId: bigint;
  letterName?: string | null;
  letterImageUrl?: string | null;

  usedLetter: boolean;
  skullTokenId: bigint; // 0 if none/unknown
  skullNonce: bigint;
  skullSvg?: string;
  skullOwner?: `0x${string}` | null;

  loading: boolean;
};

function formatId(id: bigint) {
  const s = id.toString();
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
}

function shortAddr(a?: string | null) {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function humanizeMintError(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("letteralreadyused"))
    return "This Letter has already minted a Skull.";
  if (m.includes("needletter"))
    return "You don’t own that Letter tokenId in this wallet.";
  if (m.includes("mintclosed")) return "Mint is currently closed.";
  if (m.includes("sealedforever")) return "Mint is sealed forever.";
  return msg;
}

function toErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default function Home() {
  const { address, isConnected, chain } = useAccount();

  // ✅ Force reads on Shape (important!)
  const publicClient = usePublicClient({ chainId: shape.id });

  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const wrongChain = isConnected && chain?.id !== shape.id;

  const [items, setItems] = useState<Item[]>([]);
  const [loadingLetters, setLoadingLetters] = useState(false);
  const [donationEth, setDonationEth] = useState("0");
  const [toast, setToast] = useState<string | null>(null);

  async function hydrateSkulls(current: Item[]) {
    if (!publicClient) return;
    if (current.length === 0) return;

    // mark loading
    setItems((prev) => prev.map((x) => ({ ...x, loading: true })));

    const next: Item[] = await Promise.all(
      current.slice(0, 80).map(async (it) => {
        try {
          const [usedLetter, skullTokenId] = await Promise.all([
            publicClient.readContract({
              address: LETTER_SKULL_ADDRESS,
              abi: LETTER_SKULL_ABI,
              functionName: "usedLetterToken",
              args: [it.letterTokenId],
            }) as Promise<boolean>,
            publicClient.readContract({
              address: LETTER_SKULL_ADDRESS,
              abi: LETTER_SKULL_ABI,
              functionName: "skullOfLetter",
              args: [it.letterTokenId],
            }) as Promise<bigint>,
          ]);

          const minted = usedLetter || skullTokenId !== ZERO;

          // If contract says used but skullOfLetter is 0, still disable mint (failsafe).
          if (!minted || skullTokenId === ZERO) {
            return {
              ...it,
              usedLetter,
              skullTokenId,
              skullOwner: null,
              skullNonce: ZERO,
              skullSvg: undefined,
              loading: false,
            };
          }

          const [owner, nonce] = await Promise.all([
            publicClient.readContract({
              address: LETTER_SKULL_ADDRESS,
              abi: LETTER_SKULL_ABI,
              functionName: "ownerOf",
              args: [skullTokenId],
            }) as Promise<`0x${string}`>,
            publicClient.readContract({
              address: LETTER_SKULL_ADDRESS,
              abi: LETTER_SKULL_ABI,
              functionName: "nonceOf",
              args: [skullTokenId],
            }) as Promise<bigint>,
          ]);

          const svg = (await publicClient.readContract({
            address: LETTER_SKULL_ADDRESS,
            abi: LETTER_SKULL_ABI,
            functionName: "previewSvg",
            args: [it.letterTokenId, nonce],
          })) as string;

          return {
            ...it,
            usedLetter,
            skullTokenId,
            skullOwner: owner,
            skullNonce: nonce,
            skullSvg: svg,
            loading: false,
          };
        } catch {
          // If reads fail, keep item but stop loading (don’t incorrectly show mintable forever)
          return { ...it, loading: false };
        }
      })
    );

    setItems((prev) => [...next, ...prev.slice(next.length)]);
  }

  async function loadLettersFromApi() {
    if (!address) return;

    setLoadingLetters(true);
    setToast(null);

    try {
      const res = await fetch("/api/get-nfts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });

      const json: unknown = await res.json();

      if (!res.ok) {
        const msg =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as { error?: unknown }).error ?? "Failed to fetch letters")
            : "Failed to fetch letters";
        throw new Error(msg);
      }

      const letters =
        typeof json === "object" && json !== null && "letters" in json
          ? ((json as { letters?: unknown }).letters as Array<{
              tokenId: string;
              name?: string | null;
              imageUrl?: string | null;
            }>) ?? []
          : [];

      const parsed = letters
        .map((l) => ({
          letterTokenId: BigInt(l.tokenId),
          letterName: l.name ?? null,
          letterImageUrl: l.imageUrl ?? null,
        }))
        .sort((a, b) => (a.letterTokenId < b.letterTokenId ? -1 : 1));

      const nextItems: Item[] = parsed.map((l) => ({
        letterTokenId: l.letterTokenId,
        letterName: l.letterName,
        letterImageUrl: l.letterImageUrl,

        usedLetter: false,
        skullTokenId: ZERO,
        skullNonce: ZERO,
        skullSvg: undefined,
        skullOwner: null,

        loading: true,
      }));

      setItems(nextItems);
      hydrateSkulls(nextItems);
    } catch (err: unknown) {
      setToast(toErrorMessage(err) ?? "Failed to load Letters");
      setItems([]);
    } finally {
      setLoadingLetters(false);
    }
  }

  useEffect(() => {
    if (isConnected && address) loadLettersFromApi();
    else setItems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  useEffect(() => {
    if (isConfirmed) {
      setToast("✅ Mint confirmed");
      hydrateSkulls(items);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmed]);

  function mintOne(letterTokenId: bigint) {
    setToast(null);
    const donation = donationEth.trim() === "" ? "0" : donationEth.trim();
    const value = donation === "0" ? ZERO : parseEther(donation);

    writeContract({
      address: LETTER_SKULL_ADDRESS,
      abi: LETTER_SKULL_ABI,
      functionName: "mint",
      args: [letterTokenId],
      value,
    });
  }

  const hasLetters = items.length > 0;

  const mintableCount = useMemo(() => {
    return items.filter((x) => !x.loading && !x.usedLetter && x.skullTokenId === ZERO)
      .length;
  }, [items]);

  return (
    <div className="space-y-8 pb-[220px]">
      <div className="space-y-4">
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          LetterSkull
        </h1>

        <p className="text-muted-foreground max-w-2xl text-lg">
          A SKULL FOR YOU — a fully on-chain generative art project by{" "}
          <a
            href="https://x.com/0xfilter8"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            filter8
          </a>
          .
        </p>

        <div className="text-muted-foreground max-w-2xl space-y-3 text-base leading-relaxed">
          <p>Every Skull is born from a Letter.</p>
          <p>
            The contract binds them 1:1 — a Skull can only exist if you hold its
            corresponding Letter token. The Letter’s tokenId becomes the seed.
            The seed shapes the form. The form becomes the Skull.
          </p>
          <p>
            No metadata servers. No IPFS dependencies. The SVG, the palette, the
            composition — everything is generated and stored fully on-chain.
            Immutable. Deterministic. Eternal.
          </p>
        </div>
      </div>

      {!isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect your wallet</CardTitle>
            <CardDescription>Use the top-right button.</CardDescription>
          </CardHeader>
        </Card>
      ) : wrongChain ? (
        <Card>
          <CardHeader>
            <CardTitle>Wrong network</CardTitle>
            <CardDescription>
              Please switch to Shape Mainnet to mint.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={loadLettersFromApi}
              variant="secondary"
              disabled={loadingLetters}
            >
              {loadingLetters ? "Loading…" : "Refresh"}
            </Button>

            <div className="text-muted-foreground text-sm">
              Letters: <b>{items.length}</b> • Mintable: <b>{mintableCount}</b>
            </div>

            {(isPending || isConfirming) && (
              <div className="text-sm">
                Minting… {isConfirming ? "confirming" : "sign tx"}
              </div>
            )}

            {(toast || error) && (
              <div className="text-sm">
                {toast ? (
                  toast
                ) : (
                  <span className="text-red-500">
                    {humanizeMintError(error!.message)}
                  </span>
                )}
              </div>
            )}
          </div>

          {!hasLetters ? (
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="text-2xl">No Letter found</CardTitle>
                <CardDescription className="text-base">
                  You need a Letter to mint a Skull.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <a
                  href="https://letters.shape.network/"
                  target="_blank"
                  rel="noreferrer"
                  className="block w-full rounded-xl border bg-muted px-6 py-10 text-center text-2xl font-bold tracking-tight hover:bg-muted/70"
                >
                  A LETTER FOR YOU
                </a>
              </CardContent>
            </Card>
          ) : (
            <div
              className={
                items.length <= 1
                  ? "space-y-4"
                  : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              }
            >
              {items.map((it) => {
                const minted = it.usedLetter || it.skullTokenId !== ZERO;

                const ownedByYou =
                  minted && it.skullOwner && address
                    ? it.skullOwner.toLowerCase() === address.toLowerCase()
                    : true;

                const disableMint =
                  minted || isPending || isConfirming || it.loading;

                // ✅ ONE LETTER: premium layout
                if (items.length <= 1) {
                  return (
                    <Card
                      key={it.letterTokenId.toString()}
                      className="overflow-hidden"
                    >
                      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_1fr]">
                        {/* LEFT — LETTER */}
                        <div className="flex items-center justify-center">
                          <div className="w-full max-w-[520px]">
                            {it.letterImageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={it.letterImageUrl}
                                alt={it.letterName ?? "Letter"}
                                className="mx-auto w-full rounded-xl border"
                              />
                            ) : (
                              <div className="text-muted-foreground text-sm">
                                Loading letter image…
                              </div>
                            )}
                          </div>
                        </div>

                        {/* RIGHT — SKULL / MINT */}
                        <div className="flex flex-col justify-center space-y-4">
                          <div className="space-y-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-xl font-semibold">
                                {it.letterName
                                  ? it.letterName
                                  : `Letter #${formatId(it.letterTokenId)}`}
                              </div>
                              {minted ? (
                                <span className="text-xs text-green-500">
                                  Skull minted
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  Mintable
                                </span>
                              )}
                            </div>

                            {minted && (
                              <div className="text-muted-foreground text-sm">
                                {it.skullTokenId !== ZERO ? (
                                  <>
                                    Skull #{it.skullTokenId.toString()}
                                    {it.skullOwner ? (
                                      <>
                                        {" "}
                                        • owner:{" "}
                                        <span
                                          className={
                                            ownedByYou
                                              ? "text-green-500"
                                              : "text-yellow-500"
                                          }
                                        >
                                          {ownedByYou
                                            ? "you"
                                            : shortAddr(it.skullOwner)}
                                        </span>
                                      </>
                                    ) : null}
                                  </>
                                ) : (
                                  <>Already minted • syncing skull id…</>
                                )}
                              </div>
                            )}
                          </div>

                          {/* ✅ BIG Skull */}
                          {minted && it.skullTokenId !== ZERO && (
                            <div className="bg-muted rounded-lg p-4 flex justify-center">
                              {it.skullSvg ? (
                                <div
                                  className="
                                    aspect-square
                                    w-full
                                    max-w-[520px]
                                    [&>svg]:w-full
                                    [&>svg]:h-full
                                  "
                                  style={{ imageRendering: "pixelated" }}
                                  dangerouslySetInnerHTML={{ __html: it.skullSvg }}
                                />
                              ) : (
                                <div className="text-muted-foreground text-sm">
                                  Rendering skull…
                                </div>
                              )}
                            </div>
                          )}

                          <Button
                            className="w-full"
                            disabled={disableMint}
                            onClick={() => mintOne(it.letterTokenId)}
                          >
                            {minted
                              ? "Already minted"
                              : it.loading
                              ? "Loading…"
                              : "Mint Skull"}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                }

                // ✅ multi-letter grid card
                return (
                  <Card
                    key={it.letterTokenId.toString()}
                    className="overflow-hidden"
                  >
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center justify-between text-base">
                        <span>
                          {it.letterName
                            ? it.letterName
                            : `Letter #${formatId(it.letterTokenId)}`}
                        </span>
                        {minted ? (
                          <span className="text-xs text-green-500">
                            Skull minted
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Mintable
                          </span>
                        )}
                      </CardTitle>

                      {minted && (
                        <CardDescription className="text-xs">
                          {it.skullTokenId !== ZERO ? (
                            <>
                              Skull #{it.skullTokenId.toString()}
                              {it.skullOwner ? (
                                <>
                                  {" "}
                                  • owner:{" "}
                                  <span
                                    className={
                                      ownedByYou
                                        ? "text-green-500"
                                        : "text-yellow-500"
                                    }
                                  >
                                    {ownedByYou
                                      ? "you"
                                      : shortAddr(it.skullOwner)}
                                  </span>
                                </>
                              ) : null}
                            </>
                          ) : (
                            <>Already minted • syncing skull id… (Refresh)</>
                          )}
                        </CardDescription>
                      )}
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <div className="bg-muted rounded-lg p-3">
                        {it.letterImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={it.letterImageUrl}
                            alt={it.letterName ?? "Letter"}
                            className="mx-auto h-auto w-full max-w-[260px] rounded-md"
                          />
                        ) : (
                          <div className="text-muted-foreground text-sm">
                            Loading letter image…
                          </div>
                        )}
                      </div>

                      {minted && it.skullTokenId !== ZERO && (
                        <div className="bg-muted rounded-lg p-3 flex justify-center">
                          {it.skullSvg ? (
                            <div
                              className="
                                aspect-square
                                w-full
                                max-w-[220px]
                                [&>svg]:w-full
                                [&>svg]:h-full
                              "
                              style={{ imageRendering: "pixelated" }}
                              dangerouslySetInnerHTML={{ __html: it.skullSvg }}
                            />
                          ) : (
                            <div className="text-muted-foreground text-sm">
                              Rendering skull…
                            </div>
                          )}
                        </div>
                      )}

                      <Button
                        className="w-full"
                        disabled={disableMint}
                        onClick={() => mintOne(it.letterTokenId)}
                      >
                        {minted
                          ? "Already minted"
                          : it.loading
                          ? "Loading…"
                          : "Mint Skull"}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="sticky bottom-0 z-50 border-t bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <div className="font-semibold">Donation (optional)</div>
            <div className="text-muted-foreground text-sm">
              Sent to donation wallet when you mint.
            </div>
          </div>

          <div className="flex w-full items-center gap-2 sm:w-[360px]">
            <input
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              value={donationEth}
              onChange={(e) => setDonationEth(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
            <div className="text-muted-foreground text-sm">ETH</div>
          </div>
        </div>
      </div>
    </div>
  );
}
