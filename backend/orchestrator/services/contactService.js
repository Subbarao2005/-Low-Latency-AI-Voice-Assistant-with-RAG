const { randomUUID } = require("crypto");
const { query } = require("./databaseService");
const { ValidationError } = require("../validators/leadValidator");

function field(data, key, required = false) {
  const result = typeof data[key] === "string" ? data[key].trim() : "";
  if (required && !result) throw new ValidationError(`${key} is required`);
  if (result.length > 500) throw new ValidationError(`${key} is too long`);
  return result;
}

function mapContact(row) {
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, company: row.company, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function createContact(data) {
  const name = field(data, "name", true);
  const phone = field(data, "phone");
  const email = field(data, "email").toLowerCase();
  if (!phone && !email) throw new ValidationError("A valid phone number or email is required");
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new ValidationError("email is invalid");
  const existing = await query("SELECT * FROM contacts WHERE ($1 <> '' AND phone = $1) OR ($2 <> '' AND LOWER(email) = LOWER($2)) LIMIT 1", [phone, email]);
  if (existing.rows[0]) return { success: true, action: "create_contact", created: false, existing: true, contact: mapContact(existing.rows[0]) };
  const result = await query("INSERT INTO contacts (id, name, phone, email, company, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [randomUUID(), name, phone, email, field(data, "company"), field(data, "notes")]);
  return { success: true, action: "create_contact", created: true, contact: mapContact(result.rows[0]) };
}

async function getContact(data) {
  const id = field(data, "contactId") || field(data, "id");
  const phone = field(data, "phone");
  const email = field(data, "email").toLowerCase();
  if (!id && !phone && !email) throw new ValidationError("contactId, phone, or email is required");
  const result = await query("SELECT * FROM contacts WHERE ($1 <> '' AND id = $1) OR ($2 <> '' AND phone = $2) OR ($3 <> '' AND LOWER(email) = LOWER($3)) LIMIT 1", [id, phone, email]);
  return result.rows[0] ? { success: true, action: "get_contact", contact: mapContact(result.rows[0]) } : { success: false, action: "get_contact", error: "Contact not found" };
}

async function updateContact(data) {
  const id = field(data, "contactId") || field(data, "id");
  if (!id) throw new ValidationError("contactId is required");
  const allowed = ["name", "phone", "email", "company", "notes"];
  const fields = allowed.filter((key) => data[key] !== undefined).map((key) => [key, field(data, key)]);
  if (!fields.length) return { success: false, action: "update_contact", error: "No fields to update" };
  const assignments = fields.map(([key], index) => `${key} = $${index + 2}`);
  const result = await query(`UPDATE contacts SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...fields.map(([, value]) => value)]);
  return result.rows[0] ? { success: true, action: "update_contact", contact: mapContact(result.rows[0]) } : { success: false, action: "update_contact", error: "Contact not found" };
}

module.exports = { createContact, getContact, updateContact };