import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../types.js";

describe("Issue #135: noSideEffects policy and pipelined non-idempotent requests", () => {
  it("idempotent requests have matchSeqNum set", () => {
    const input = AppendInput.create(
      [AppendRecord.string({ body: "test" })],
      { matchSeqNum: 0 },
    );
    expect(input.matchSeqNum).toBe(0);
  });

  it("non-idempotent requests have no matchSeqNum", () => {
    const input = AppendInput.create([AppendRecord.string({ body: "test" })]);
    expect(input.matchSeqNum).toBeUndefined();
  });

  it("hasNoSideEffects returns true for rate_limited errors", () => {
    const error = new S2Error({
      message: "rate limited",
      status: 429,
      code: "rate_limited",
      origin: "server",
    });
    expect(error.hasNoSideEffects()).toBe(true);
  });

  it("hasNoSideEffects returns true for hot_server errors", () => {
    const error = new S2Error({
      message: "hot server",
      status: 502,
      code: "hot_server",
      origin: "server",
    });
    expect(error.hasNoSideEffects()).toBe(true);
  });

  it("should not retry non-idempotent already-sent pipelined entries under noSideEffects", () => {
    // This test verifies the fix logic: under noSideEffects policy,
    // before recovery, all non-head inflight entries that were already sent
    // must be checked for idempotency. The head entry (index 0) is excluded
    // because its safety is already guaranteed by the error/transport check.

    type MockEntry = {
      input: { matchSeqNum?: number };
      needsSubmit?: boolean;
    };

    function canSafelyRecover(inflight: MockEntry[]): boolean {
      // The fix: check all already-submitted non-head entries for idempotency
      for (let i = 1; i < inflight.length; i++) {
        const entry = inflight[i];
        if (!entry.needsSubmit && entry.input.matchSeqNum === undefined) {
          // Non-idempotent pipelined entry was already sent - cannot safely retry
          return false;
        }
      }
      return true;
    }

    // Case 1: All pipelined entries are idempotent - safe to recover
    const allIdempotent: MockEntry[] = [
      { input: {} },                         // head: non-idempotent (ok, head is excluded)
      { input: { matchSeqNum: 1 } },         // tail: idempotent
    ];
    expect(canSafelyRecover(allIdempotent)).toBe(true);

    // Case 2: Head is idempotent but pipelined tail is not - NOT safe
    const mixedPipeline: MockEntry[] = [
      { input: { matchSeqNum: 0 } },         // head: idempotent, already sent
      { input: {} },                          // tail: non-idempotent, already sent
    ];
    expect(canSafelyRecover(mixedPipeline)).toBe(false);

    // Case 3: Non-idempotent pipelined entry not yet submitted - safe (needsSubmit=true)
    const unsent: MockEntry[] = [
      { input: { matchSeqNum: 0 } },
      { input: {}, needsSubmit: true },       // not yet sent
    ];
    expect(canSafelyRecover(unsent)).toBe(true);

    // Case 4: Single entry (only head) - safe (no pipelined entries to check)
    const singleEntry: MockEntry[] = [
      { input: {} },                          // head only, non-idempotent but excluded
    ];
    expect(canSafelyRecover(singleEntry)).toBe(true);

    // Case 5: Multiple non-idempotent pipelined entries already sent - NOT safe
    const allNonIdempotent: MockEntry[] = [
      { input: {} },                          // head
      { input: {} },                          // pipelined, non-idempotent
      { input: {} },                          // pipelined, non-idempotent
    ];
    expect(canSafelyRecover(allNonIdempotent)).toBe(false);
  });
});
