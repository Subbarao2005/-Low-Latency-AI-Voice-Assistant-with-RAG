const { randomUUID } = require("crypto");
const { query } = require("./databaseService");
const { validateLead, ValidationError } = require("../validators/leadValidator");

function text(value, field, required = false) {
  if (typeof value !== "string") value = "";
  const result = value.trim();
  if (required && !result) throw new ValidationError(`${field} is required`);
  if (result.length > 500) throw new ValidationError(`${field} is too long`);
  return result;
}

function mapLead(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    requirement: row.requirement,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createLead(data) {
  const lead = validateLead(data);
  const duplicate = await query(
    `SELECT * FROM leads WHERE ($1 <> '' AND phone = $1) OR ($2 <> '' AND LOWER(email) = LOWER($2)) LIMIT 1`,
    [lead.phone, lead.email]
  );
  if (duplicate.rows[0]) {
    return { success: true, action: "create_lead", created: false, existing: true, lead: mapLead(duplicate.rows[0]) };
  }
  const id = randomUUID();
  const result = await query(
    `INSERT INTO leads (id, name, phone, email, company, requirement, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, lead.name, lead.phone || null, lead.email, lead.company, lead.requirement, lead.status, lead.source]
  );
  return { success: true, action: "create_lead", lead: mapLead(result.rows[0]) };
}

async function getLead(data) {
  const id = text(data.leadId || data.id, "leadId");
  const phone = text(data.phone, "phone");
  const email = text(data.email, "email").toLowerCase();
  if (!id && !phone && !email) throw new ValidationError("leadId, phone, or email is required");
  const result = await query(
    "SELECT * FROM leads WHERE ($1 <> '' AND id = $1) OR ($2 <> '' AND phone = $2) OR ($3 <> '' AND LOWER(email) = LOWER($3)) LIMIT 1",
    [id, phone, email]
  );
  return result.rows[0]
    ? { success: true, action: "get_lead", lead: mapLead(result.rows[0]) }
    : { success: false, error: "Lead not found" };
}

async function updateLead(data) {
  const id = text(data.leadId || data.id, "leadId", true);
  const lead = validateLead(data, { partial: true });
  const current = await query("SELECT * FROM leads WHERE id = $1", [id]);
  if (!current.rows[0]) return { success: false, action: "update_lead", error: "Lead not found" };
  const merged = validateLead({
    name: data.name ?? current.rows[0].name,
    phone: data.phone ?? current.rows[0].phone,
    email: data.email ?? current.rows[0].email,
    company: data.company ?? current.rows[0].company,
    requirement: data.requirement ?? current.rows[0].requirement,
    status: data.status ?? current.rows[0].status,
    source: data.source ?? current.rows[0].source,
  });
  const fields = Object.entries(lead).filter(([key, value]) => key !== "status" && key !== "source" && value !== "");
  if (data.status !== undefined) fields.push(["status", merged.status]);
  if (data.source !== undefined) fields.push(["source", merged.source]);
  if (!fields.length) return { success: false, error: "No fields to update" };
  const assignments = fields.map(([key], index) => `${key} = $${index + 2}`);
  const result = await query(
    `UPDATE leads SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...fields.map(([, value]) => value || null)]
  );
  return result.rows[0]
    ? { success: true, action: "update_lead", lead: mapLead(result.rows[0]) }
    : { success: false, error: "Lead not found" };
}

async function addNote(data) {
  const leadId = text(data.leadId, "leadId", true);
  const note = text(data.note, "note", true);
  const result = await query(
    "INSERT INTO lead_notes (lead_id, note) VALUES ($1, $2) RETURNING id, lead_id, note, created_at",
    [leadId, note]
  );
  return { success: true, action: "add_note", note: result.rows[0] };
}

module.exports = { createLead, getLead, updateLead, addNote, validateLead, text };