const { Pool } = require("pg");

let pool;
let schemaReady;

function getPool() {
  if (!process.env.DATABASE_URL) {
    const error = new Error("Persistent database is not configured");
    error.statusCode = 503;
    error.publicMessage = "Lead persistence is not configured";
    throw error;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        requirement TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        source TEXT NOT NULL DEFAULT 'voice-assistant',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS lead_notes (
        id BIGSERIAL PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS leads_phone_unique
        ON leads (phone) WHERE phone IS NOT NULL AND phone <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS leads_email_unique
        ON leads (LOWER(email)) WHERE email IS NOT NULL AND email <> '';
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        amount NUMERIC,
        currency TEXT NOT NULL DEFAULT 'INR',
        stage TEXT NOT NULL DEFAULT 'new',
        expected_close_date DATE,
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
  await schemaReady;
}

async function query(text, values) {
  await ensureSchema();
  return getPool().query(text, values);
}

module.exports = { query };