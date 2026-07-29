import { describe, expect, it, vi } from "vitest";
import type { FeedbackResponse } from "@trionlabs/stellar8004";
import { collectFeedbackWindow, type ToolDeps } from "../src/tools/shared.js";

function feedback(feedbackIndex: number): FeedbackResponse {
  return {
    feedbackIndex,
    clientAddress: "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V",
    value: 90,
    valueDecimals: 0,
    tag1: null,
    tag2: null,
    endpoint: null,
    feedbackUri: null,
    isRevoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    responses: [],
  };
}

function depsWithPages(
  pages: Record<number, { data: FeedbackResponse[]; hasMore: boolean }>,
): ToolDeps {
  return {
    policy: { maxFeedbackScanPages: 3 },
    explorer: {
      getFeedback: vi.fn(async (_agentId: number, params?: { page?: number }) => {
        const page = params?.page ?? 1;
        const result = pages[page] ?? { data: [], hasMore: false };
        return {
          data: result.data,
          meta: {
            chain: "stellar",
            network: "mainnet",
            pagination: { page, limit: 20, total: 0, hasMore: result.hasMore },
          },
        };
      }),
    },
  } as unknown as ToolDeps;
}

describe("collectFeedbackWindow coverage", () => {
  it("marks a full final page exhausted when upstream says hasMore=false", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => feedback(index + 1));
    const window = await collectFeedbackWindow(
      depsWithPages({ 1: { data: rows, hasMore: false } }),
      10,
      { page: 1, limit: 10, includeRevoked: false },
    );

    expect(window.coverage).toEqual({
      windowComplete: true,
      paginationExhausted: true,
      snapshotConsistent: true,
      pagesScanned: 1,
      hasMore: false,
    });
  });

  it("marks an offset window assembled from multiple responses snapshot-inconsistent", async () => {
    const first = Array.from({ length: 20 }, (_, index) => feedback(index + 1));
    const second = Array.from({ length: 5 }, (_, index) => feedback(index + 21));
    const window = await collectFeedbackWindow(
      depsWithPages({
        1: { data: first, hasMore: true },
        2: { data: second, hasMore: false },
      }),
      11,
      { page: 1, limit: 25, includeRevoked: false },
    );

    expect(window.rows).toHaveLength(25);
    expect(window.coverage).toEqual({
      windowComplete: true,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 2,
      hasMore: false,
    });
  });
});
