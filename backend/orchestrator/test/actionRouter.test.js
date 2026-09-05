const test = require("node:test");
const assert = require("node:assert/strict");
const { routeAction, registeredActions } = require("../actions/actionRouter");

test("only registered actions are exposed", () => {
  assert.deepEqual(registeredActions, [
    "create_lead", "get_lead", "update_lead", "add_note",
    "create_contact", "get_contact", "update_contact",
    "create_deal", "get_deal", "update_deal",
  ]);
});

test("unsupported actions are rejected without database access", async () => {
  const result = await routeAction({ action: "delete_everything", data: {} });
  assert.equal(result.success, false);
  assert.deepEqual(result.error, { code: "UNSUPPORTED_ACTION", message: "Unsupported action" });
});

test("malformed action requests are rejected", async () => {
  const result = await routeAction(null);
  assert.equal(result.success, false);
  assert.deepEqual(result.error, { code: "INVALID_REQUEST", message: "Invalid action request" });
});

test("action payloads must be objects", async () => {
  const result = await routeAction({ type: "action", action: "create_lead", data: "not-an-object" });
  assert.equal(result.error.code, "INVALID_REQUEST");
});