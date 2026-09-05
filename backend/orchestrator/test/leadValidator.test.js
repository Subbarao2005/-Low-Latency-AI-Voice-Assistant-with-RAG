const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLead } = require("../validators/leadValidator");

test("lead accepts email without phone and normalizes fields", () => {
  const lead = validateLead({ name: " Rahul ", email: "RAHUL@EXAMPLE.COM", requirement: "Website" });
  assert.equal(lead.name, "Rahul");
  assert.equal(lead.email, "rahul@example.com");
  assert.equal(lead.status, "new");
});

test("lead requires at least one contact method", () => {
  assert.throws(() => validateLead({ name: "Rahul" }), /phone number or email/);
});

test("lead rejects invalid statuses and phone values", () => {
  assert.throws(() => validateLead({ name: "Rahul", phone: "123", status: "unknown" }), /phone is invalid/);
  assert.throws(() => validateLead({ name: "Rahul", phone: "9876543210", status: "unknown" }), /status must be one of/);
});