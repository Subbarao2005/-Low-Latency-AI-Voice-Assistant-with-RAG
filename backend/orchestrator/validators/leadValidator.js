const ALLOWED_STATUSES = new Set(["new", "contacted", "qualified", "proposal", "won", "lost"]);
const MAX_LENGTH = 500;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = "VALIDATION_ERROR";
    this.publicMessage = message;
  }
}

function value(data, field) {
  const input = data[field];
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new ValidationError(`${field} must be a string`);
  const result = input.trim();
  if (result.length > MAX_LENGTH) throw new ValidationError(`${field} is too long`);
  return result;
}

function normalizePhone(phone) {
  return phone.replace(/[ ()-]/g, "");
}

function validateLead(data, { partial = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("Lead data must be an object");
  }

  const lead = {
    name: value(data, "name"),
    phone: value(data, "phone"),
    email: value(data, "email").toLowerCase(),
    company: value(data, "company"),
    requirement: value(data, "requirement"),
    status: value(data, "status") || "new",
    source: value(data, "source") || "voice-assistant",
  };

  if (!partial && !lead.name) throw new ValidationError("name is required");
  if (!partial && !lead.phone && !lead.email) {
    throw new ValidationError("A valid phone number or email is required");
  }
  if (lead.phone) {
    const normalized = normalizePhone(lead.phone);
    if (!/^\+?[0-9]{7,20}$/.test(normalized)) {
      throw new ValidationError("phone is invalid");
    }
    lead.phone = normalized;
  }
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    throw new ValidationError("email is invalid");
  }
  if (!ALLOWED_STATUSES.has(lead.status)) {
    throw new ValidationError(`status must be one of: ${[...ALLOWED_STATUSES].join(", ")}`);
  }

  return lead;
}

module.exports = { ALLOWED_STATUSES, ValidationError, validateLead, normalizePhone };