/**
 * Real CLI transcripts.
 *
 * Every string below is literal output from running a local release build against
 * Stellar mainnet on 2026-07-29, pasted unedited except for two things:
 *   - trailing whitespace on padded table columns is stripped (invisible, and it
 *     otherwise leaks into the reader's clipboard);
 *   - nothing else. No numbers, statuses or ordering have been touched.
 *
 * If you change the ranking policy, the verification logic or the output format,
 * re-run these three commands and paste the new output. A landing page showing
 * invented terminal output would undercut the exact claim this project makes.
 */

export const CAPTURED_ON = '29 July 2026';

/** `rank` — the declared-reputation heuristic and fail-closed contract reachability status. */
export const RANK = {
	command: 'stellar-agent-search rank "scraping agents"',
	output: `Ranked 2 agent(s) on mainnet (policy stellar-agent-search-declared-evidence-v1; evidence volume=0.4 breadth=0.6):

#  ID  SCORE  STATUS   X402  MPP  SVC  NAME (self-declared, unverified)
-  --  -----  -------  ----  ---  ---  --------------------------------
1  10     50  unavailable  yes   -    yes  Scrapper Agent
2   6     19  unavailable  -     -    yes  Crawler Scraper Agent

  agent 10: quality 0.968 × evidence 0.520 (capped volume 0.224 + breadth 0.296) = score 0.503; owner-declared capability contribution 0
  agent 6: quality 0.600 × evidence 0.314 (capped volume 0.112 + breadth 0.202) = score 0.188; owner-declared capability contribution 0
ℹ bounded discovery scanned 66 record(s) across 2 page(s); results are not registry-global.`,
	caption:
		'Quality is multiplied by a fixed declared-evidence index: 0.4 capped volume + 0.6 distinct-client breadth. Evidence cannot manufacture a positive score from zero quality. It is still indexer-declared—not Sybil-proof.'
};

/** `profile` — declared Explorer data plus the exact limit of the contract probe. */
export const PROFILE = {
	command: 'stellar-agent-search profile 10',
	output: `Agent 10  (mainnet)
  stellarId : stellar:mainnet:CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35#10
  owner     : GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V
  wallet    : (none — payTo comes from the x402 challenge)
  score     : 50/100   evidence 0.520 (index, not probability; stellar-agent-search-declared-evidence-v1)
  reputation: unavailable  (declared avg 96.75 over 8 feedback)
  evidence  : client-set-exhaustion-unprovable; snapshotComparable=no; no reputation field verified
  capability: x402=yes mpp=- services=1 trust=[reputation]

  self-declared (UNVERIFIED):
    name        : Scrapper Agent
    description : Scrapes URLs and returns structured data (title, text, links). Powered by x402 micropayments on Ste…
    service     : x402 → https://scrapper.stellar8004.com/task (v1.0)`,
	caption:
		'The bounded client-list call proves reachability only. Because sparse client-index holes make exhaustion unprovable, the server does not call get_summary and verifies no reputation fields.'
};

/**
 * The same `profile 10` run above, as structured values — so the hero can render
 * the diff as a designed artifact instead of asking the reader to parse a table.
 * Nothing here is independent of PROFILE.output; if that changes, change this.
 *
 * `96.75` remains explicitly Explorer-declared data. The contract-side value is
 * reachability, not a second reputation number: sparse client indexes mean a
 * finite page cannot prove the full client set, so no summary is requested.
 *
 * Every field below names its source. On a page about the gap between declared
 * data and provable evidence, an unlabelled value is a defect.
 */
export const SAMPLE = {
	agentId: 10,
	name: 'Scrapper Agent',
	status: 'unavailable' as const,
	declared: '96.75',
	declaredSource: 'explorer indexer',
	onchain: 'reachable',
	onchainSource: 'Reputation contract probe',
	note: 'client-set-exhaustion-unprovable: the contract answered, but a bounded client page cannot prove that no later live client exists. No reputation fields are compared.',
	verifiedFields: 'none',
	onchainClientCoverage: 'active unique clients not derived',
	/** Computed from Explorer-declared reputation under the local heuristic. */
	rank: '50/100',
	evidenceStrength: '0.520'
};

/** The five schema statuses; only unavailable/skipped are emitted by the current implementation. */
export const VERDICTS = [
	{
		key: 'verified',
		tone: 'positive',
		meaning: 'Future-reserved: an authoritative read covers every declared reputation field.'
	},
	{
		key: 'partial',
		tone: 'accent',
		meaning: 'Reserved for a future authoritative comparison of a strict subset of reputation fields.'
	},
	{
		key: 'mismatch',
		tone: 'warning',
		meaning: 'Future-reserved: an authoritative field comparison diverges; not emitted by the current probe.'
	},
	{
		key: 'unavailable',
		tone: 'dim',
		meaning: 'No reputation field can be compared; this includes reachable-but-non-exhaustive client enumeration.'
	},
	{
		key: 'skipped',
		tone: 'dim',
		meaning: 'Verification was not requested for this agent — declared figures only.'
	}
] as const;

/** `doctor` — the self-check, and the plainest evidence of the keyless invariant. */
export const DOCTOR = {
	command: 'stellar-agent-search doctor',
	output: `✔ node      v26.4.0 (>=22 required)
✔ network   mainnet
✔ read-only keyless (no signer, no writes)
✔ explorer  https://stellar8004.com  status=healthy  identity=63708789/fresh reputation=63708789/fresh validation=63708789/fresh
✔ soroban   https://mainnet.sorobanrpc.com  healthy
✔ contract  read path OK (sample #10 returned 4 address(es) from bounded indices 0..5; not an exhaustive client count; verification unavailable)
✔ tools     find_agent, rank_agent, get_agent_profile, list_services (+ list_agents, leaderboard)
ℹ server    stellar-agent-search  ·  @modelcontextprotocol/server 2.0.0  ·  spec 2025-11-25`,
	caption: undefined
};
