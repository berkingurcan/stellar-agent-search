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
 *   other Error     → INTERNAL
 */

import {
  ApiError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@trionlabs/stellar8004";
import { toolError, type ToolErrorBody, type ToolResult } from "../types.js";

/** True when `err` is one of the SDK's typed API errors. */
export function isSdkError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Classify any thrown value into a stable, typed error body. */
export function classifyError(err: unknown): ToolErrorBody {
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
