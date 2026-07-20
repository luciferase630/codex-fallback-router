import assert from "node:assert/strict";
import test from "node:test";

import { prepareFallbackRequestBody } from "../../src/context.js";

function prepare(request: Record<string, unknown>, fallbackModel?: string): Record<string, unknown> {
  const prepared = prepareFallbackRequestBody(
    Buffer.from(JSON.stringify(request)),
    fallbackModel,
  );
  return JSON.parse(prepared.body.toString("utf8")) as Record<string, unknown>;
}

test("preserves portable multi-turn, tool and compacted context", () => {
  const input = [
    { role: "developer", content: [{ type: "input_text", text: "Project rules" }] },
    { role: "user", content: [{ type: "input_text", text: "First turn" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "result" },
    { type: "compaction", encrypted_content: "portable-compacted-context" },
    { role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ];
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
  const prepared = prepare({ model: "current-model", input, tools, stream: true, store: true });

  assert.equal(prepared.model, "current-model");
  assert.equal(prepared.store, false);
  assert.deepEqual(prepared.input, input);
  assert.deepEqual(prepared.tools, tools);
  assert.equal(prepared.stream, true);
});

test("maps the model only when explicitly configured", () => {
  const prepared = prepare({ model: "current-model", input: "hello" }, "explicit-fallback-model");
  assert.equal(prepared.model, "explicit-fallback-model");
});

test("blocks provider-scoped or missing conversation history", () => {
  assert.throws(
    () => prepare({ model: "model", input: "hello", previous_response_id: "response_1" }),
    /previous_response_id/,
  );
  assert.throws(
    () => prepare({ model: "model", input: "hello", conversation: { id: "conversation_1" } }),
    /provider-side conversation/,
  );
  assert.throws(() => prepare({ model: "model", input: [] }), /portable input context/);
  assert.throws(() => prepare({ input: "hello" }), /model name/);
  assert.throws(() => prepareFallbackRequestBody(Buffer.from("not-json")), /not valid JSON/);
});
