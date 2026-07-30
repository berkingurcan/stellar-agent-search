# P2-09 — Substantiate or soften the "only live non-EVM" claim

**Owner:** Code · **Status:** resolved — softened, with the gap in the evidence stated inline

## Problem

`README.md` stated that stellar-8004 is the **"only live non-EVM ERC-8004 implementation"**. This was the one
factual claim in the README with no source behind it.

The paper cited alongside it — [arXiv 2606.26028](https://arxiv.org/abs/2606.26028), *Can Trustless Agents Be
Trusted?* — restricts its analysis to Ethereum, BSC and Base, "the three chains with the highest registration
and feedback volume". It therefore neither confirms nor refutes "only".

The other README claims *were* verified and hold: "3–15% of registrations have a live endpoint" matches the
paper's "3%, 4%, and 15%"; "59–91% of reviewers are Sybils" matches "73.5%, 59.2%, and 90.6%"; and the live
registry currently reports `totalAgents: 66`.

## Fix

Softened, not sourced — no published survey enumerates ERC-8004 deployments on non-EVM chains, so there is
nothing to cite. The README now reads "the only non-EVM ERC-8004 implementation **we are aware of** running on
mainnet", and says in the same breath why no stronger claim is available: the one study in the field covers
three EVM chains by design, so "only" is **unrefuted, not proven**.

Stating the gap inline rather than dropping the claim keeps it checkable by a reviewer who does know of a
counter-example — which is the point. Revisit if a survey covering non-EVM chains appears.

## Acceptance

- [x] The claim is either sourced or softened. — softened, with the limit of the available evidence named.
