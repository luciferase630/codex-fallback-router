import assert from "node:assert/strict";
import test from "node:test";

import { QuotaLatch } from "../../src/latch.js";
import { classifyQuotaResponse, classifyQuotaSseEvent } from "../../src/quota.js";

test("recognizes only strong Plus or workspace quota exhaustion signals", () => {
  assert.equal(
    classifyQuotaResponse(429, JSON.stringify({ error: { code: "usage_limit_exceeded" } })).isQuotaExhausted,
    true,
  );
  assert.equal(
    classifyQuotaResponse(403, JSON.stringify({ error: { type: "workspace_member_credits_depleted" } })).isQuotaExhausted,
    true,
  );
  assert.equal(
    classifyQuotaResponse(429, JSON.stringify({ error: { message: "Weekly limit has been reached" } })).isQuotaExhausted,
    true,
  );
  assert.equal(
    classifyQuotaResponse(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })).isQuotaExhausted,
    false,
  );
  assert.equal(
    classifyQuotaResponse(401, JSON.stringify({ error: { code: "usage_limit_exceeded" } })).isQuotaExhausted,
    false,
  );
  assert.equal(classifyQuotaResponse(500, "usage limit reached").isQuotaExhausted, false);
});

test("extracts reset times and recognizes quota errors in the first SSE event", () => {
  const now = 1_700_000_000_000;
  const resetAt = now + 120_000;
  const decision = classifyQuotaResponse(
    429,
    JSON.stringify({ error: { code: "usageLimitExceeded", resets_at: resetAt / 1000 } }),
    now,
  );
  assert.deepEqual(decision, { isQuotaExhausted: true, resetAt });

  const event = Buffer.from(
    `event: error\ndata: ${JSON.stringify({ error: { code: "usage_limit_exceeded" } })}\n\n`,
  );
  assert.equal(classifyQuotaSseEvent(event, now).isQuotaExhausted, true);
  assert.equal(classifyQuotaSseEvent(Buffer.from("data: {\"type\":\"response.output_text.delta\"}\n\n"), now).isQuotaExhausted, false);
});

test("latches until a known reset or the bounded default interval", () => {
  const latch = new QuotaLatch(15 * 60_000);
  const now = 10_000;
  assert.equal(latch.activate(undefined, now), now + 15 * 60_000);
  assert.equal(latch.isActive(now + 1), true);
  assert.equal(latch.isActive(now + 15 * 60_000), false);

  const knownReset = now + 30 * 60_000;
  assert.equal(latch.activate(knownReset, now), knownReset);
  assert.equal(latch.until, knownReset);
  latch.clear();
  assert.equal(latch.isActive(now), false);
});
