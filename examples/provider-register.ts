/**
 * examples/provider-register.ts — register an agent so stellar-agent-search can find it.
 *
 * The provider-side counterpart of x402-demo.ts. It builds an ERC-8004 registration file with the canonical
 * @trionlabs/stellar8004 SDK, validates it, stores it as a `data:` URI (no IPFS account needed under 8 KB),
 * and — only when REGISTER=1 — signs `register_with_uri` on the Identity contract.
 *
 * Defaults are deliberately safe:
 *   - STELLAR_NETWORK defaults to `testnet`. Mainnet needs an explicit STELLAR_NETWORK=mainnet.
 *   - Without REGISTER=1 nothing is signed or sent: the script prints the registration file and exits.
 *
 * Like x402-demo.ts this is a SEPARATE keyed process. Nothing under src/ may import a signer; the MCP server
 * stays read-only and keyless. Guide: docs/build-a-discoverable-agent.md.
 *
 *   AGENT_NAME="Acme Scraper" AGENT_DESCRIPTION="Web scraping agent: fetches a URL and returns clean markdown" \
 *   SERVICE_ENDPOINT=https://scraper.example.com/task AGENT_X402=1 \
 *   npx tsx examples/provider-register.ts                       # dry run: print and validate only
 *
 *   ... STELLAR_PRIVATE_KEY=S... FUND_TESTNET=1 REGISTER=1 npx tsx examples/provider-register.ts
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  buildMetadataJson,
  createClients,
  formatSorobanError,
  fundTestnet,
  getConfig,
  getMetadataSize,
  toDataUri,
  validateMetadataJson,
  validateUrl,
  wrapBasicSigner,
} from "@trionlabs/stellar8004";

/** AutoStorage's data-URI ceiling; larger registration files belong on IPFS (PinataStorage). */
const MAX_DATA_URI_BYTES = 8 * 1024;
const TRUST_MODELS = new Set(["reputation", "crypto-economic", "tee-attestation", "validation"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (see the header of examples/provider-register.ts)`);
  return value;
}

function network(): "testnet" | "mainnet" {
  const raw = (process.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new Error(`STELLAR_NETWORK must be 'testnet' or 'mainnet', got '${raw}'`);
  }
  return raw;
}

function buildRegistration(): Record<string, unknown> {
  const services = [];
  const endpoint = process.env.SERVICE_ENDPOINT?.trim();
  if (endpoint) {
    const urlError = validateUrl(endpoint);
    if (urlError) throw new Error(`SERVICE_ENDPOINT: ${urlError}`);
    if (!endpoint.startsWith("https://")) throw new Error("SERVICE_ENDPOINT must be https://");
    services.push({
      name: process.env.SERVICE_NAME?.trim() || "task",
      endpoint,
      version: process.env.SERVICE_VERSION?.trim() || "v1",
    });
  }

  const supportedTrust = (process.env.AGENT_TRUST ?? "reputation")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of supportedTrust) {
    if (!TRUST_MODELS.has(t)) throw new Error(`AGENT_TRUST: unknown trust model '${t}'`);
  }

  const metadata = buildMetadataJson({
    name: required("AGENT_NAME"),
    description: required("AGENT_DESCRIPTION"),
    imageUrl: process.env.AGENT_IMAGE_URL?.trim() ?? "",
    services,
    supportedTrust,
    x402Enabled: process.env.AGENT_X402 === "1",
  });
  validateMetadataJson(metadata);
  return metadata;
}

async function main(): Promise<void> {
  const net = network();
  const metadata = buildRegistration();
  const size = getMetadataSize(metadata);
  if (size > MAX_DATA_URI_BYTES) {
    throw new Error(`registration file is ${size} bytes; over ${MAX_DATA_URI_BYTES} use PinataStorage (IPFS)`);
  }
  const agentUri = toDataUri(metadata);

  console.log(`network: ${net}`);
  console.log(`registration file (${size} bytes):`);
  console.log(JSON.stringify(metadata, null, 2));

  if (process.env.REGISTER !== "1") {
    console.log("\nDry run: nothing signed. Set REGISTER=1 and STELLAR_PRIVATE_KEY to register.");
    return;
  }

  const keypair = Keypair.fromSecret(required("STELLAR_PRIVATE_KEY"));
  const stellar = getConfig(net);
  if (net === "testnet" && process.env.FUND_TESTNET === "1") {
    await fundTestnet(keypair.publicKey());
  }

  const signer = wrapBasicSigner(keypair, stellar.networkPassphrase);
  const { identity } = createClients(stellar, signer);
  try {
    const tx = await identity.register_with_uri({ caller: keypair.publicKey(), agent_uri: agentUri });
    const sent = await tx.signAndSend();
    const agentId = sent.result;
    console.log(`\nregistered agent #${agentId} on ${net} (owner ${keypair.publicKey()})`);
    console.log("\nSee it the way other agents will (reads the Identity contract directly, no indexer wait):");
    console.log(
      `  STELLAR_NETWORK=${net} REGISTRY_AGENT_IDS=${agentId} npx -y stellar-agent-search@0.1.0 profile ${agentId}`,
    );
    console.log(
      `  STELLAR_NETWORK=${net} REGISTRY_AGENT_IDS=${agentId} npx -y stellar-agent-search@0.1.0 find "<a query your users would type>"`,
    );
  } catch (err) {
    throw new Error(`registration failed: ${formatSorobanError(err)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
