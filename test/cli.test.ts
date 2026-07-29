import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, type AgentResponse } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import { parseFlags, runCli } from "../src/cli/index.js";
import type { ToolDeps } from "../src/tools/shared.js";

const coverage = {
  coverageComplete: true,
  paginationExhausted: true,
  snapshotConsistent: true,
  pagesScanned: 1,
  recordsScanned: 1,
  hasMore: false,
} as const;

function agent(id: number, withService = false): AgentResponse {
  return {
    id,
    owner: `owner-${id}`,
    name: `agent-${id}`,
    description: "payments agent",
    hasServices: withService,
    x402Enabled: false,
    scores: { average: 80, total: 80, feedbackCount: 1, uniqueClients: 1 },
    services: withService
      ? [{ name: `service-${id}`, endpoint: `https://agent-${id}.example/run` }]
      : [],
  } as unknown as AgentResponse;
}

function fakeDeps(overrides: {
  agents?: AgentResponse[];
  getAgent?: (id: number) => Promise<{ data: AgentResponse }>;
  verifyAgainst?: (...args: unknown[]) => Promise<unknown>;
} = {}): ToolDeps {
  const agents = overrides.agents ?? [agent(1)];
  return {
    config: loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "true" }),
    explorer: {
      findAgentsWithCoverage: vi.fn(async () => ({
        agents,
        coverage: { ...coverage, recordsScanned: agents.length },
      })),
      getAgent: vi.fn(overrides.getAgent ?? (async (id: number) => ({ data: agent(id) }))),
    } as unknown as ToolDeps["explorer"],
    verifier: {
      verifyAgainst: vi.fn(
        overrides.verifyAgainst ??
          (async (_id: unknown, declared: unknown, opts: unknown) => ({
            status: "skipped",
            declared,
            reason: "not-requested",
            verifiedFields: [],
            unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
            checkedAt: "2026-07-29T00:00:00.000Z",
            opts,
          })),
      ),
    } as unknown as ToolDeps["verifier"],
  };
}

function captureWrites(): { stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return { stdout: () => stdout, stderr: () => stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential("CLI flag correctness", () => {
  it("parses --verify and rejects contradictory verification flags", () => {
    expect(parseFlags(["find", "payments", "--verify"]).verify).toBe(true);
    expect(() => parseFlags(["find", "payments", "--verify", "--no-verify"]))
      .toThrow("mutually exclusive");
  });

  it.each([
    ["--limit", "0"],
    ["--limit", "51"],
    ["--limit", "1.5"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--min-score", "-1"],
    ["--min-score", "101"],
    ["--min-score", "10.5"],
  ])("rejects out-of-range or non-integer %s %s", (flag, value) => {
    expect(() => parseFlags(["find", "payments", flag, value])).toThrow(/expects an integer/);
  });

  it("accepts every numeric boundary", () => {
    expect(parseFlags(["find", "x", "--limit", "1"]).limit).toBe(1);
    expect(parseFlags(["find", "x", "--limit", "50"]).limit).toBe(50);
    expect(parseFlags(["serve", "--port", "1"]).port).toBe(1);
    expect(parseFlags(["serve", "--port", "65535"]).port).toBe(65_535);
    expect(parseFlags(["find", "x", "--min-score", "0"]).minScore).toBe(0);
    expect(parseFlags(["find", "x", "--min-score", "100"]).minScore).toBe(100);
  });
});

describe.sequential("CLI bounded hydration and errors", () => {
  it("makes find verification a real, explicit opt-in", async () => {
    const io = captureWrites();
    const verifyAgainst = vi.fn(async (_id: unknown, declared: unknown, opts: unknown) => ({
      status: "unavailable",
      declared,
      reason: "rpc-error",
      verifiedFields: [],
      unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
      checkedAt: "2026-07-29T00:00:00.000Z",
      opts,
    }));
    const code = await runCli(
      parseFlags(["find", "payments", "--verify", "--json"]),
      "0.1.0",
      fakeDeps({ verifyAgainst }),
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.stdout()).count).toBe(1);
    expect(verifyAgainst).toHaveBeenCalledTimes(1);
    expect(verifyAgainst.mock.calls[0]?.[2]).toMatchObject({ skip: false });
  });

  it("limits explicit-id detail fan-out to four", async () => {
    captureWrites();
    let inFlight = 0;
    let maxInFlight = 0;
    const getAgent = vi.fn(async (id: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { data: agent(id) };
    });
    const ids = Array.from({ length: 9 }, (_, i) => String(i + 1));

    const code = await runCli(
      parseFlags(["rank", ...ids, "--no-verify", "--json"]),
      "0.1.0",
      fakeDeps({ getAgent }),
    );

    expect(code).toBe(0);
    expect(getAgent).toHaveBeenCalledTimes(9);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("limits find on-chain verification fan-out to four", async () => {
    captureWrites();
    let inFlight = 0;
    let maxInFlight = 0;
    const verifyAgainst = vi.fn(async (_id: unknown, declared: unknown) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {
        status: "unavailable",
        declared,
        reason: "rpc-error",
        verifiedFields: [],
        unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
        checkedAt: "2026-07-29T00:00:00.000Z",
      };
    });
    const agents = Array.from({ length: 9 }, (_, i) => agent(i + 1));

    const code = await runCli(
      parseFlags(["find", "payments", "--verify", "--limit", "9", "--json"]),
      "0.1.0",
      fakeDeps({ agents, verifyAgainst }),
    );

    expect(code).toBe(0);
    expect(verifyAgainst).toHaveBeenCalledTimes(9);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("skips only NotFound detail races and reports incomplete hydration", async () => {
    const io = captureWrites();
    const agents = [agent(1), agent(2)];
    const code = await runCli(
      parseFlags(["services", "--json"]),
      "0.1.0",
      fakeDeps({
        agents,
        getAgent: async (id) => {
          if (id === 1) throw new NotFoundError("agent 1");
          return { data: agent(id, true) };
        },
      }),
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.stdout());
    expect(result.count).toBe(1);
    expect(result.coverage).toMatchObject({ coverageComplete: false, hydrationMissing: 1 });
  });

  it("propagates service hydration outages instead of faking empty services", async () => {
    const io = captureWrites();
    const code = await runCli(
      parseFlags(["services", "--json"]),
      "0.1.0",
      fakeDeps({
        agents: [agent(1)],
        getAgent: async () => {
          throw new Error("explorer unavailable");
        },
      }),
    );

    expect(code).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("explorer unavailable");
  });
});
