# Provider Standard v1 fixtures

`manifests.json` is a verbatim copy of `packages/protocol/test-vectors/manifests.json` from
[Stellar Agent Services](https://github.com/AlgoriaLabs/stellar-agent-services) at commit `cc4fbda` (MIT License,
Copyright (c) 2026 Stellar Agent Services contributors). It holds the standard's manifest validation vectors:
valid manifests, and manifests that break one rule each.

`test/provider-standard.test.ts` runs `src/lib/provider-standard.ts` over every case. Copy the file again when the
standard adds vectors; don't edit it here.
