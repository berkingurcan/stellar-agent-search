# P3-24 — Load-safe and 8004 validated badges from the verification receipt

**Owner:** Code · **Status:** open — needs a durable way to locate a receipt

## Problem

`get_provider_manifest` derives the Provider Standard level badges (Standard v1, Payment verified, Recovery
verified) from a trusted validator's Validation Registry record: the record's `response` is the conformance score,
and the score is fixed per level. Two badges can't be derived that way:

- **Load-safe** needs check C7 to have passed.
- **8004 validated** needs check C2 (identity) to have passed, and the registry to anchor that receipt.

Both are in the verification receipt, not in the record. The registry stores the receipt's SHA-256
(`response_hash`) but not its URL: `response_uri` exists only in the `validation_response` contract event, and a
public Soroban RPC keeps events for days. Every attested result therefore carries the limitation
`receipt-badges-not-derived`.

## Options

1. **Events within the retention window.** `last_update` is the exact ledger of the latest answer, so one
   `getEvents` call from that ledger finds the event while the RPC still has it. Older records keep the gap, so
   this helps only fresh verifications.
2. **A content-addressed receipt location per trusted validator.** Verifiers already publish a receipt as
   `<sha256>.json`. An operator setting that maps a trusted validator to its receipts base URL lets the server
   fetch `<base>/<response_hash>.json`, hash it and compare it with the record: nothing to trust beyond the hash.
3. **A Provider Standard rule.** The standard could say where a receipt lives, for example under an
   `extensions` key in the manifest. That is a spec change in Stellar Agent Services first, and then this server.

Option 2 needs no spec change and works for every record. Option 3 is the durable one.

## Acceptance

- [ ] A trusted record's receipt is fetched (public HTTPS, no redirect, size cap), its SHA-256 equals
      `response_hash`, and its `standard`, `agentId`, `network`, `validator` and `score` match the record.
- [ ] Load-safe and 8004 validated are derived exactly as the verifier's `badgesFor` derives them; the
      `receipt-badges-not-derived` limitation is dropped only when they were.
- [ ] Any mismatch or unreadable receipt leaves those two badges out and says why; the level badges stand.
