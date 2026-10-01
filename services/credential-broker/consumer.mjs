import { createTransport } from "./transport.mjs";
import { exact, uuid, input, string, fail } from "./schema.mjs";
/** Agent-facing consumer accepts only its scoped bearer and connection, never a vault identity. */
export function createSyntheticConsumer({
  origin,
  ca,
  bearer,
  connectionId,
  fixture,
}) {
  uuid(connectionId);
  if (typeof bearer !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bearer))
    fail("INVALID_REQUEST");
  const send = createTransport({
    origin,
    ca,
    fixture,
    resolve: fixture
      ? async () => [{ address: fixture.address, family: 4 }]
      : undefined,
  });
  return {
    async execute(operation, request, idempotencyKey, approvalId) {
      input(operation, request);
      string(idempotencyKey, 128);
      if (approvalId) uuid(approvalId);
      const result = await send("POST", "/v1/operations", {
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: {
          connection_id: connectionId,
          operation,
          input: request,
          ...(approvalId ? { approval_id: approvalId } : {}),
        },
      });
      exact(result, ["operation", "contract_version"]);
      if (result.contract_version !== "broker.v1")
        fail("BROKER_UNAVAILABLE", 503);
      return result.operation;
    },
  };
}
