"use client";

import { config } from "@/lib/config";
import { http, fallback } from "viem";
import { mainnet, shape, shapeSepolia } from "viem/chains";
import { createConfig } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

const appOrigin =
  typeof window !== "undefined" ? window.location.origin : "https://builder-kit.vercel.app";

const connectors =
  typeof window !== "undefined"
    ? [
        injected(),
        ...(config.walletConnectProjectId
          ? [
              walletConnect({
                projectId: config.walletConnectProjectId,
                showQrModal: true,
                metadata: {
                  name: "Builder Kit",
                  description: "Builder Kit on Shape",
                  url: appOrigin,
                  icons: [`${appOrigin}/favicon.ico`],
                },
              }),
            ]
          : []),
      ]
    : [];

// ✅ Public fallback RPCs (safe + helps if Alchemy hiccups)
const SHAPE_PUBLIC = "https://mainnet.shape.network";
const SHAPE_SEPOLIA_PUBLIC = "https://sepolia.shape.network"; // if this ever fails, remove it
const ETH_PUBLIC = "https://cloudflare-eth.com";

export const wagmiConfig = createConfig({
  chains: [shape, shapeSepolia, mainnet],
  connectors,
  ssr: true,
  transports: {
    // ✅ IMPORTANT: batch disabled for Shape → fixes "reads show mintable but mint reverts"
    [shape.id]: fallback([
      http(`https://shape-mainnet.g.alchemy.com/v2/${config.alchemyKey}`, { batch: false }),
      http(SHAPE_PUBLIC, { batch: false }),
    ]),
    [shapeSepolia.id]: fallback([
      http(`https://shape-sepolia.g.alchemy.com/v2/${config.alchemyKey}`, { batch: false }),
      http(SHAPE_SEPOLIA_PUBLIC, { batch: false }),
    ]),
    [mainnet.id]: fallback([
      http(`https://eth-mainnet.g.alchemy.com/v2/${config.alchemyKey}`, { batch: false }),
      http(ETH_PUBLIC, { batch: false }),
    ]),
  },
});
