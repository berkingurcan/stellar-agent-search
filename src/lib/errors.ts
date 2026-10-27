/**
 * errors.ts — map @trionlabs/stellar8004 SDK errors to MCP tool error results.
 *
 * We surface upstream/data failures as isError:true tool results (not JSON-RPC
 * protocol errors) so the model can read the reason and react. Zod input
 * validation is handled by the MCP SDK before our handler runs and is NOT
 * mapped here.
 *
 * Mapping (modules/01 §2.4.3):
 *   RateLimitError  → RATE_LIMITED  (+retryAfterMs)
 *   NotFoundError   → NOT_FOUND
 *   ValidationError → BAD_REQUEST
 *   ApiError        → UPSTREAM_ERROR (+status detail)
 *   RegistryReadError    → UPSTREAM_ERROR (direct Identity contract read)
 *   IndexerRequiredError → INDEXER_REQUIRED (not available in registry mode)
 *   other Error     → INTERNAL
 */

import {
  ApiError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@trionlabs/stellar8004";
import { toolError, type ToolErrorBody, type ToolResult } from "../types.js";

/** Explorer answered for a different (or unidentifiable) chain/network. */
export class ExplorerScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorerScopeError";
  }
}

/** Explorer returned HTTP success with a malformed or impossible data payload. */
export class UpstreamDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamDataError";
  }
}

/** A direct Identity contract read or registration-file fetch failed (registry mode). */
export class RegistryReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RegistryReadError";
  }
}

/**
 * The request needs an indexer, and this server reads the registry directly.
 * Registry mode has no feedback history, stats, health, owner index or indexed
 * reputation, so it refuses rather than answer from a partial view.
 */
export class IndexerRequiredError extends Error {
  constructor(feature: string) {
    super(
      `${feature} needs an indexer, and this server is in registry mode: it reads the Identity contract ` +
        `directly for the agents in REGISTRY_AGENT_IDS. To use it, set EXPLORER_BASE_URL to an indexer ` +
        `for this network instead.`,
    );
    this.name = "IndexerRequiredError";
  }
}

/** True when `err` is one of the SDK's typed API errors. */
export function isSdkError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Classify any thrown value into a stable, typed error body. */
export function classifyError(err: unknown): ToolErrorBody {
  if (err instanceof UpstreamDataError) {
    return { error: err.message, code: "UPSTREAM_ERROR", detail: "malformed explorer payload" };
  }
  if (err instanceof ExplorerScopeError) {
    return { error: err.message, code: "UPSTREAM_ERROR", detail: "chain/network scope mismatch" };
  }
  if (err instanceof IndexerRequiredError) {
    return { error: err.message, code: "INDEXER_REQUIRED", detail: "registry mode" };
  }
  if (err instanceof RegistryReadError) {
    return { error: err.message, code: "UPSTREAM_ERROR", detail: "registry read failed" };
  }
  if (err instanceof RateLimitError) {
    return {
      error: "Explorer rate limited — retry shortly.",
      code: "RATE_LIMITED",
      retryAfterMs: err.retryAfterMs,
    };
  }
  if (err instanceof NotFoundError) {
    return { error: err.message, code: "NOT_FOUND" };
  }
  if (err instanceof ValidationError) {
    return { error: err.message, code: "BAD_REQUEST" };
  }
  if (err instanceof ApiError) {
    return {
      error: err.message,
      code: "UPSTREAM_ERROR",
      detail: `status=${err.status}`,
    };
  }
  if (err instanceof Error) {
    return { error: err.message, code: "INTERNAL" };
  }
  return { error: "Unknown error", code: "INTERNAL" };
}

/** Map any thrown value to an MCP tool error result. */
export function mapErrorToToolResult(err: unknown): ToolResult {
  return toolError(classifyError(err));
}
