export interface PreparedFallbackBody {
  body: Buffer;
  model: string;
  inputItems: number;
}

function hasServerScopedValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function prepareFallbackRequestBody(
  body: Buffer,
  fallbackModel?: string,
): PreparedFallbackBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Responses request is not valid JSON, so its context cannot be verified.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Responses request body is not a JSON object.");
  }
  const request = parsed as Record<string, unknown>;
  if (hasServerScopedValue(request.previous_response_id)) {
    throw new Error(
      "Request depends on previous_response_id; fallback was blocked to avoid losing conversation history.",
    );
  }
  if (hasServerScopedValue(request.conversation)) {
    throw new Error(
      "Request depends on a provider-side conversation object; fallback was blocked to avoid losing history.",
    );
  }
  const input = request.input;
  const inputItems = Array.isArray(input) ? input.length : typeof input === "string" && input ? 1 : 0;
  if (inputItems === 0) {
    throw new Error("Request does not contain portable input context; fallback was blocked.");
  }
  const originalModel = typeof request.model === "string" ? request.model.trim() : "";
  const model = fallbackModel?.trim() || originalModel;
  if (!model) throw new Error("Responses request does not contain a model name.");
  const prepared = {
    ...request,
    model,
    store: false,
  };
  return {
    body: Buffer.from(JSON.stringify(prepared), "utf8"),
    model,
    inputItems,
  };
}

