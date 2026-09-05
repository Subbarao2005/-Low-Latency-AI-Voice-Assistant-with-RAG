const { randomUUID } = require("crypto");
const { query } = require("./databaseService");
const { ValidationError } = require("../validators/leadValidator");

const DEAL_STAGES = new Set(["new", "qualified", "proposal", "won", "lost"]);

function text(data, key, required = false) {
  const result = typeof data[key] === "string" ? data[key].trim() : "";
  if (required && !result) throw new ValidationError(`${key} is required`);
  if (result.length > 500) throw new ValidationError(`${key} is too long`);
  return result;
}

function mapDeal(row) {
  return { id: row.id, leadId: row.lead_id, contactId: row.contact_id, title: row.title, amount: row.amount, currency: row.currency, stage: row.stage, expectedCloseDate: row.expected_close_date, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at };
}

function validated(data, partial = false) {
  const deal = { title: text(data, "title"), amount: data.amount === undefined ? null : Number(data.amount), currency: (text(data, "currency") || "INR").toUpperCase(), stage: text(data, "stage") || "new", expectedCloseDate: text(data, "expectedCloseDate"), notes: text(data, "notes"), leadId: text(data, "leadId"), contactId: text(data, "contactId") };
  if (!partial && !deal.title) throw new ValidationError("title is required");
  if (deal.amount !== null && (!Number.isFinite(deal.amount) || deal.amount < 0)) throw new ValidationError("amount is invalid");
  if (!/^[A-Z]{3}$/.test(deal.currency)) throw new ValidationError("currency is invalid");
  if (!DEAL_STAGES.has(deal.stage)) throw new ValidationError(`stage must be one of: ${[...DEAL_STAGES].join(", ")}`);
  if (deal.expectedCloseDate && !/^\d{4}-\d{2}-\d{2}$/.test(deal.expectedCloseDate)) throw new ValidationError("expectedCloseDate must use YYYY-MM-DD");
  return deal;
}

async function createDeal(data) {
  const deal = validated(data);
  const result = await query("INSERT INTO deals (id, lead_id, contact_id, title, amount, currency, stage, expected_close_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [randomUUID(), deal.leadId || null, deal.contactId || null, deal.title, deal.amount, deal.currency, deal.stage, deal.expectedCloseDate || null, deal.notes]);
  return { success: true, action: "create_deal", deal: mapDeal(result.rows[0]) };
}

async function getDeal(data) {
  const id = text(data, "dealId") || text(data, "id");
  if (!id) throw new ValidationError("dealId is required");
  const result = await query("SELECT * FROM deals WHERE id = $1", [id]);
  return result.rows[0] ? { success: true, action: "get_deal", deal: mapDeal(result.rows[0]) } : { success: false, action: "get_deal", error: "Deal not found" };
}

async function updateDeal(data) {
  const id = text(data, "dealId") || text(data, "id");
  if (!id) throw new ValidationError("dealId is required");
  const deal = validated(data, true);
  const keys = ["title", "amount", "currency", "stage", "expectedCloseDate", "notes", "leadId", "contactId"];
  const fields = keys.filter((key) => data[key] !== undefined).map((key) => [key, deal[key]]);
  if (!fields.length) return { success: false, action: "update_deal", error: "No fields to update" };
  const columns = { expectedCloseDate: "expected_close_date", leadId: "lead_id", contactId: "contact_id" };
  const assignments = fields.map(([key], index) => `${columns[key] || key} = $${index + 2}`);
  const result = await query(`UPDATE deals SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...fields.map(([, value]) => value || null)]);
  return result.rows[0] ? { success: true, action: "update_deal", deal: mapDeal(result.rows[0]) } : { success: false, action: "update_deal", error: "Deal not found" };
}

module.exports = { createDeal, getDeal, updateDeal, DEAL_STAGES };