/**
 * Real CLI transcripts.
 *
 * Every string below is literal output from running a local release build against
 * Stellar mainnet on 2026-07-29, pasted unedited except for two things:
 *   - trailing whitespace on padded table columns is stripped (invisible, and it
 *     otherwise leaks into the reader's clipboard);
 *   - nothing else. No numbers, statuses or ordering have been touched.
 *
 * If you change the ranking weights, the verification logic or the output format,
 * re-run these three commands and paste the new output. A landing page showing
 * invented terminal output would undercut the exact claim this project makes.
 */

export const CAPTURED_ON = '29 July 2026';

/** `rank` — the 3-axis score with its full breakdown, and on-chain verification per agent. */
export const RANK = {
	command: 'stellar-agent-mcp rank "scraping agents"',
	output: `Ranked 2 agent(s) on mainnet (weights q=0.5 v=0.2 b=0.3):

#  ID  SCORE  STATUS   X402  MPP  SVC  NAME (self-declared, unverified)
-  --  -----  -------  ----  ---  ---  --------------------------------
1  10     82  partial  yes   -    yes  Scrapper Agent
2   6     49  partial  -     -    yes  Crawler Scraper Agent

  agent 10: base 0.744 = quality 0.484 + volume 0.112 + breadth 0.148; bonuses pay=0.05 endpoint=0.03 verified=0.00; confidence 53%
  agent 6: base 0.457 = quality 0.300 + volume 0.056 + breadth 0.101; bonuses pay=0.00 endpoint=0.03 verified=0.00; confidence 30%
ℹ bounded discovery scanned 66 record(s) across 2 page(s); results are not registry-global.`,
	caption:
		'Weights are quality 0.5, volume 0.2, breadth 0.3. Breadth counts distinct clients and outranks review volume, on the reasoning that distinct counterparties are harder to acquire than repeat reviews.'
};

/** `profile` — the declared-vs-verified diff, which is the whole point of the server. */
export const PROFILE = {
	command: 'stellar-agent-mcp profile 10',
	output: `Agent 10  (mainnet)
  stellarId : stellar:mainnet:CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35#10
  owner     : GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V
  wallet    : (none — payTo comes from the x402 challenge)
  score     : 82/100   confidence 53%
  reputation: partial  (declared avg 96.75 vs on-chain 96)
  capability: x402=yes mpp=- services=1 trust=[reputation]

  self-declared (UNVERIFIED):
    name        : Scrapper Agent
    description : Scrapes URLs and returns structured data (title, text, links). Powered by x402 micropayments on Ste…
    service     : x402 → https://scrapper.stellar8004.com/task (v1.0)`,
	// The previous caption here said the directory and the contract "say different
	// things". They do not: 96.75 and 96 are the same number at the precision the
	// contract stores. Describing a match as a divergence was exactly the error
	// this page exists to argue against.
	caption:
		'The average and active feedback count agree at the contract\'s precision. The status remains partial because the current contract read cannot derive active unique clients.'
};

/**
 * The same `profile 10` run above, as structured values — so the hero can render
 * the diff as a designed artifact instead of asking the reader to parse a table.
 * Nothing here is independent of PROFILE.output; if that changes, change this.
 *
 * The `note` explains why 96.75 and 96 are a match rather than a divergence, and
 * it is not a simplification: src/lib/reputation.ts truncates the declared average to
 * the chain's precision when the on-chain average is an integer, because the
 * contract truncates the mean and the fractional part is not independently
	 * verifiable against it. Tolerance is 0.5 on the average and exact (0) on feedback count.
 * Active unique clients remain explicitly unverified by this contract read.
 *
 * Every field below names which side it came from. On a page about the gap
 * between declared and on-chain figures, an unlabelled number is a defect.
 */
export const SAMPLE = {
	agentId: 10,
	name: 'Scrapper Agent',
	status: 'partial' as const,
	declared: '96.75',
	declaredSource: 'explorer indexer',
	onchain: '96',
	onchainSource: 'Reputation contract',
	note: 'Average and active feedback count agree in two unversioned observations. Explorer and Soroban do not share a snapshot; active unique clients are not derivable from the append-only client list, so this is partial—not fully verified.',
	/** Read from the contract, via doctor's sampled verification of agent 10. */
	onchainFeedback: 8,
	onchainClientCoverage: 'active unique clients not derived',
	/** Computed by the server from both sides, not read from either. */
	rank: '82/100',
	confidence: '53%'
};

/** The four verdicts the server can return. Source: src/types.ts, VerificationStatus. */
export const VERDICTS = [
	{
		key: 'verified',
		tone: 'positive',
		meaning: 'Reserved for a future read that covers every declared reputation field.'
	},
	{
		key: 'partial',
		tone: 'accent',
		meaning: 'Bounded observations agree for average and count; there is no common snapshot, and active unique clients remain unverified.'
	},
	{
		key: 'mismatch',
		tone: 'warning',
		meaning: 'Unversioned Explorer and Soroban observations differ beyond tolerance; this is not proof of manipulation.'
	},
	{
		key: 'unavailable',
		tone: 'dim',
		meaning: 'The chain read failed, so nothing is asserted either way.'
	},
	{
		key: 'skipped',
		tone: 'dim',
		meaning: 'Verification was not requested for this agent — declared figures only.'
	}
] as const;

/** `doctor` — the self-check, and the plainest evidence of the keyless invariant. */
export const DOCTOR = {
	command: 'stellar-agent-mcp doctor',
	output: `✔ node      v26.4.0 (>=20 required)
✔ network   mainnet
✔ read-only keyless (no signer, no writes)
✔ explorer  https://stellar8004.com  status=healthy  identity ledger 63707891 (fresh)
✔ soroban   https://mainnet.sorobanrpc.com  healthy
✔ verify    on-chain reputation read OK (sampled agent #10: avg 96, 8 comparable feedback; active unique clients are not derived by this read)
✔ tools     find_agent, rank_agent, get_agent_profile, list_services (+ list_agents, leaderboard)
ℹ server    stellar-agent-mcp  ·  @modelcontextprotocol/server 2.0.0  ·  spec 2025-11-25`,
	caption: undefined
};
