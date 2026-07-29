import { describe, expect, it } from "vitest";
import { assertFetchOnlyBundleText } from "../scripts/assert-fetch-bundle.mjs";

describe("Worker fetch-only bundle gate", () => {
  it("accepts the v16 fetch transport surface", () => {
    expect(() =>
      assertFetchOnlyBundleText(
        'import { Client } from "@stellar/stellar-sdk/contract"; fetch("https://rpc.example");',
      ),
    ).not.toThrow();
  });

  it("accepts feaxios, Stellar's fetch-backed compatibility shim", () => {
    expect(() =>
      assertFetchOnlyBundleText(
        '// ../node_modules/feaxios/dist/index.mjs\nclass AxiosError extends Error {}\naxios.create({});',
      ),
    ).not.toThrow();
  });

  it.each([
    'import axios from "node_modules/axios/index.js";',
    'import { Client } from "@stellar/stellar-sdk/axios/contract";',
  ])("rejects axios implementation code", (source) => {
    expect(() => assertFetchOnlyBundleText(source)).toThrow(/axios implementation marker/i);
  });
});
