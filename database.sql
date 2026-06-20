-- ============================================================================
-- AgroERP — PostgreSQL Schema (database.sql)
-- CRM + Dealer + Farmer Ecosystem  |  Derived from AgroERP_PRD.docx v1.0
--
-- SCOPE (Phase 1 — MVP): User & Role Management, Product Master, Pricing,
-- Distributors, Inventory, Order-to-Cash, GST Compliance (E-Invoice + E-Way Bill),
-- Loyalty + Farmer registry. Manufacturing and the AI/Farmer-app modules are
-- intentionally out of scope for Phase 1 (added in later phases).
--
-- Apply with:
--   psql "$DATABASE_URL" -f database.sql      -- or --      npm run db:setup
--
-- Conventions:
--   * UUID primary keys (gen_random_uuid via pgcrypto)
--   * snake_case columns; created_at / updated_at audit columns
--   * idempotent: safe to re-run (IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fast ILIKE search on names/emails

-- ─────────────────────────────────────────────────────────────
-- ENUM TYPES
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM
    ('SUPER_ADMIN','ADMIN','SUB_ADMIN','SALES','DISTRIBUTOR','FARMER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE product_category AS ENUM
    ('PESTICIDE','FERTILIZER','SEED','HERBICIDE','FUNGICIDE','INSECTICIDE','BIO_PRODUCT','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────
-- BRANCHES  (users are scoped to a branch — PRD §4.1)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  code          TEXT UNIQUE,
  state         TEXT,
  district      TEXT,
  address       TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- USERS  (central identity & access — PRD §4.1)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  role          user_role NOT NULL,
  branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Profile fields
  avatar_key    TEXT,            -- S3 object key for the (compressed) profile photo
  designation   TEXT,            -- job title, e.g. "Regional Sales Manager"
  employee_code TEXT,            -- internal staff/HR code
  gender        TEXT,            -- MALE / FEMALE / OTHER
  date_of_birth DATE,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrate existing installs to the profile columns above (idempotent).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state         TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON users USING gin (email gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- ROLE → MODULE PERMISSION MATRIX  (PRD §2.1)
-- Per-module CRUD toggles, configurable per role at runtime without code changes.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role        user_role NOT NULL,
  module      TEXT NOT NULL,
  can_create  BOOLEAN NOT NULL DEFAULT FALSE,
  can_read    BOOLEAN NOT NULL DEFAULT FALSE,
  can_update  BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role, module)
);

-- Migrate older installs (which had a TEXT `access` column) to CRUD booleans.
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS can_create BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS can_read   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS can_update BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS can_delete BOOLEAN NOT NULL DEFAULT FALSE;

-- Drop any rows whose module is not part of the current module catalog
-- (clears the legacy access-based seed so the matrix stays consistent).
DELETE FROM role_permissions WHERE module NOT IN (
  'Dashboard','User Management','Roles & Permissions','Product Master','Pricing',
  'Manufacturing','Inventory','Orders & Billing','Farmers / CRM','Loyalty',
  'AI Advisory','Complaints','Analytics'
);

-- Per-user permission overrides: an explicit grant/deny for a single user on a
-- module, taking precedence over their role's default (PRD §2.1). When no row
-- exists for (user, module), the user inherits the role_permissions default.
CREATE TABLE IF NOT EXISTS user_permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  can_create  BOOLEAN NOT NULL DEFAULT FALSE,
  can_read    BOOLEAN NOT NULL DEFAULT FALSE,
  can_update  BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, module)
);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);

-- ─────────────────────────────────────────────────────────────
-- ACTIVITY / AUDIT LOG  (PRD §4.1)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   UUID,
  ip_address  INET,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Speeds up the audit-log listing and the daily >7-day purge.
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- SEED: default CRUD permissions for each (role, module) pair.
-- Defaults (admins customise via the Roles & Permissions screen):
--   read   → all back-office roles (SUPER_ADMIN, ADMIN, SUB_ADMIN, SALES)
--   create → SUPER_ADMIN, ADMIN
--   update → SUPER_ADMIN, ADMIN, SUB_ADMIN
--   delete → SUPER_ADMIN, ADMIN
-- Existing rows are preserved (ON CONFLICT DO NOTHING) so UI edits survive re-runs.
-- ─────────────────────────────────────────────────────────────
INSERT INTO role_permissions (role, module, can_read, can_create, can_update, can_delete)
SELECT
  r.role,
  m.module,
  r.role IN ('SUPER_ADMIN','ADMIN','SUB_ADMIN','SALES'),
  r.role IN ('SUPER_ADMIN','ADMIN'),
  r.role IN ('SUPER_ADMIN','ADMIN','SUB_ADMIN'),
  r.role IN ('SUPER_ADMIN','ADMIN')
FROM (VALUES
  ('SUPER_ADMIN'::user_role), ('ADMIN'), ('SUB_ADMIN'), ('SALES'), ('DISTRIBUTOR'), ('FARMER')
) AS r(role)
CROSS JOIN (VALUES
  ('Dashboard'), ('User Management'), ('Roles & Permissions'), ('Product Master'),
  ('Pricing'), ('Manufacturing'), ('Inventory'), ('Orders & Billing'),
  ('Farmers / CRM'), ('Loyalty'), ('AI Advisory'), ('Complaints'), ('Analytics')
) AS m(module)
ON CONFLICT (role, module) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- PRODUCT MASTER  (PRD §4.2) — single source of truth for the catalog.
-- HSN + GST% drive the GST / E-Invoice engine; pricing feeds Order-to-Cash.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  sku                   TEXT UNIQUE NOT NULL,
  category              product_category NOT NULL DEFAULT 'OTHER',
  technical_name        TEXT,
  image_key             TEXT,                            -- S3 object key for the (compressed) product image
  uom                   TEXT,                            -- unit of measure: PCS/L/KG/etc (for invoice & EWB)
  packing_size          TEXT,                            -- e.g. 250ml, 1L, 1Kg
  hsn_code              TEXT,                            -- for GST invoice / IRN
  gst_percent           NUMERIC(5,2),
  mrp                   NUMERIC(12,2),
  dealer_price          NUMERIC(12,2),
  distributor_price     NUMERIC(12,2),
  target_crops          TEXT[] NOT NULL DEFAULT '{}',    -- (used by AI Advisory in later phases)
  target_diseases       TEXT[] NOT NULL DEFAULT '{}',
  season_tags           TEXT[] NOT NULL DEFAULT '{}',
  recommended_dosage    TEXT,
  application_frequency TEXT,
  safety_instructions   TEXT,
  hazard_category       TEXT,
  shelf_life_months     INT,
  storage_conditions    TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Migrate existing installs to the image column (idempotent).
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_key TEXT;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_target_diseases ON products USING gin (target_diseases);
CREATE INDEX IF NOT EXISTS idx_products_target_crops ON products USING gin (target_crops);

-- ─────────────────────────────────────────────────────────────
-- PRICING ENGINE  (PRD §4.3) — rule-based, multi-dimensional pricing.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'BASE',     -- BASE/REGION/SEASON/PROMO/DEALER_TIER
  state         TEXT,                              -- region match (state-level)
  district      TEXT,
  dealer_tier   TEXT,                              -- dealer-tier override
  price         NUMERIC(12,2) NOT NULL,
  min_quantity  INT NOT NULL DEFAULT 1,            -- quantity slab threshold
  discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  valid_from    DATE,
  valid_to      DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_rules_product ON price_rules(product_id);

-- Schemes: buy X get Y, combos, cash discounts (PRD §4.3, §8.2).
CREATE TABLE IF NOT EXISTS schemes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  scheme_type   TEXT NOT NULL DEFAULT 'DISCOUNT',  -- DISCOUNT/BUY_X_GET_Y/COMBO/CASH_DISCOUNT
  description   TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from    DATE,
  valid_to      DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- DISTRIBUTORS / DEALERS  (PRD §7.2, §8) — buyer master.
-- GSTIN + state feed the GST / E-Invoice / E-Way Bill payloads.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS distributors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  contact_person TEXT,
  phone         TEXT,
  email         TEXT,
  gstin         TEXT,
  dealer_tier   TEXT,
  state         TEXT,
  district      TEXT,
  address       TEXT,
  branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
  credit_limit  NUMERIC(14,2) NOT NULL DEFAULT 0,
  outstanding   NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_distributors_branch ON distributors(branch_id);
CREATE INDEX IF NOT EXISTS idx_distributors_name_trgm ON distributors USING gin (name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- INVENTORY  (PRD §6) — multi-warehouse, batch-aware stock.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  code          TEXT UNIQUE,
  branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number       TEXT NOT NULL,
  product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  manufacturing_date DATE,
  expiry_date        DATE,
  qc_status          TEXT NOT NULL DEFAULT 'PASSED',   -- PASSED/FAILED/UNDER_REVIEW
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_date);

CREATE TABLE IF NOT EXISTS stock_levels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id      UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  quantity      NUMERIC(14,2) NOT NULL DEFAULT 0,
  reserved      NUMERIC(14,2) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, product_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_levels(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock_levels(warehouse_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id      UUID REFERENCES batches(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL,                  -- IN / OUT / ADJUST / TRANSFER
  quantity      NUMERIC(14,2) NOT NULL,         -- signed: +in / -out
  reason        TEXT,
  ref_type      TEXT,
  ref_id        UUID,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- COMPANY SETTINGS  — seller/company profile (shown on invoices).
-- Single-row table (id = 1).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name    TEXT NOT NULL DEFAULT 'Cropland Agro Pvt. Ltd.',
  trade_name    TEXT,
  gstin         TEXT,
  pan           TEXT,
  cin           TEXT,
  email         TEXT,
  phone         TEXT,
  website       TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  state         TEXT,
  pincode       TEXT,
  logo_key      TEXT,
  bank_name     TEXT,
  bank_account  TEXT,
  bank_ifsc     TEXT,
  bank_branch   TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  invoice_terms TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO company_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- ORDER TO CASH  (PRD §7) — orders, invoices, payments, returns.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM
    ('DRAFT','PLACED','APPROVED','INVOICED','DISPATCHED','DELIVERED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;
CREATE SEQUENCE IF NOT EXISTS order_seq START 1;

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no        TEXT UNIQUE NOT NULL,
  distributor_id  UUID NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  bill_type       TEXT NOT NULL DEFAULT 'GST',         -- GST / NON_GST (decided at order time)
  status          order_status NOT NULL DEFAULT 'PLACED',
  order_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  sub_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  delivery_address TEXT,
  approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_distributor ON orders(distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_type TEXT NOT NULL DEFAULT 'GST';

CREATE TABLE IF NOT EXISTS order_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name  TEXT NOT NULL,                  -- snapshot at order time
  hsn_code      TEXT,
  uom           TEXT,
  quantity      NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(12,2) NOT NULL,
  discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_percent   NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(14,2) NOT NULL,         -- taxable value (after discount, before tax)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    TEXT UNIQUE NOT NULL,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  distributor_id UUID NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  bill_type     TEXT NOT NULL DEFAULT 'GST',         -- GST (tax invoice) / NON_GST (bill of supply)
  invoice_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  place_of_supply TEXT,
  is_interstate BOOLEAN NOT NULL DEFAULT FALSE,
  taxable_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst          NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst          NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid   NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- GST e-document fields (populated later by the GST Compliance Engine):
  irn           TEXT,
  eway_bill_no  TEXT,
  status        TEXT NOT NULL DEFAULT 'ISSUED', -- ISSUED / CANCELLED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_type TEXT NOT NULL DEFAULT 'GST';
CREATE INDEX IF NOT EXISTS idx_invoices_distributor ON invoices(distributor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    UUID REFERENCES invoices(id) ON DELETE SET NULL,
  distributor_id UUID NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method        TEXT,                            -- UPI/NEFT/RTGS/CHEQUE/CASH
  reference     TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_distributor ON payments(distributor_id, paid_at DESC);

-- (sales_returns is defined in full under RETURNS MANAGEMENT below.)

-- ─────────────────────────────────────────────────────────────
-- GST COMPLIANCE ENGINE  (PRD §7.1, §12) — E-Invoice (IRN) + E-Way Bill.
-- Generated via a provider-abstracted adapter (mock/sandbox/GSP). Full request/
-- response payloads are retained for audit, as GST law requires.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS e_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  irn             TEXT,
  ack_no          TEXT,
  ack_date        TIMESTAMPTZ,
  signed_qr       TEXT,
  signed_invoice  TEXT,
  status          TEXT NOT NULL DEFAULT 'GENERATED',  -- GENERATED / CANCELLED / FAILED
  provider        TEXT NOT NULL DEFAULT 'mock',
  cancel_reason   TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eway_bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  ewb_no          TEXT,
  ewb_date        TIMESTAMPTZ,
  valid_until     TIMESTAMPTZ,
  distance_km     INT,
  transport_mode  TEXT,                               -- ROAD/RAIL/AIR/SHIP
  vehicle_no      TEXT,
  transporter_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'GENERATED',  -- GENERATED / CANCELLED / FAILED
  provider        TEXT NOT NULL DEFAULT 'mock',
  cancel_reason   TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- FARMER REGISTRY + LOYALTY ENGINE  (PRD §4.4, §8.4-8.5, §9.6)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE loyalty_txn_type AS ENUM ('EARN','REDEEM','BONUS','ADJUST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS farmers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_code     TEXT UNIQUE NOT NULL,           -- e.g. FRM102834
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  village         TEXT,
  tehsil          TEXT,
  district        TEXT,
  state           TEXT,
  crops           TEXT[] NOT NULL DEFAULT '{}',
  land_size_acres NUMERIC(10,2),
  language        TEXT DEFAULT 'en',
  points_balance  INT NOT NULL DEFAULT 0,
  registered_by   UUID REFERENCES distributors(id) ON DELETE SET NULL,
  fcm_token       TEXT,                            -- Farmer App device token (push)
  gps_lat         NUMERIC(9,6),
  gps_lng         NUMERIC(9,6),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS idx_farmers_phone ON farmers(phone);
CREATE INDEX IF NOT EXISTS idx_farmers_name_trgm ON farmers USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS loyalty_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  rule_type     TEXT NOT NULL,                    -- PURCHASE/PRODUCT/SEASONAL/REFERRAL/FESTIVAL/FIRST_PURCHASE/MILESTONE
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from    DATE,
  valid_to      DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id     UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  points        INT NOT NULL,                     -- + earn / - redeem
  type          loyalty_txn_type NOT NULL,
  note          TEXT,
  ref_order_id  UUID REFERENCES orders(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_farmer ON loyalty_transactions(farmer_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- NOTIFICATION CENTER  (PRD §10, §12)
-- Channels: PUSH (FCM, Farmer App) · EMAIL (Nodemailer) · SMS.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience        TEXT NOT NULL,                  -- FARMERS / DISTRIBUTORS / USERS / ALL
  channels        TEXT[] NOT NULL DEFAULT '{}',   -- PUSH / EMAIL / SMS
  campaign_type   TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  target_farmer_id UUID REFERENCES farmers(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED / SENT / PARTIAL / FAILED
  result          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-channel dispatch result
  recipients      INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- CREDIT / DEBIT NOTES  (PRD §7.2) — financial adjustments to a distributor.
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS note_seq START 1;

CREATE TABLE IF NOT EXISTS credit_debit_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_no       TEXT UNIQUE NOT NULL,
  distributor_id UUID NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  note_type     TEXT NOT NULL,                   -- CREDIT (reduces outstanding) / DEBIT (increases)
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason        TEXT,
  ref_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_distributor ON credit_debit_notes(distributor_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- PHASE 2 · COMPLAINT MANAGEMENT  (PRD §9.7)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE complaint_status AS ENUM ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS complaint_seq START 1;

CREATE TABLE IF NOT EXISTS complaints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no       TEXT UNIQUE NOT NULL,
  farmer_id       UUID REFERENCES farmers(id) ON DELETE SET NULL,
  distributor_id  UUID REFERENCES distributors(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,                  -- PRODUCT_QUALITY/WRONG_PRODUCT/PEST_DAMAGE/ADVISORY_FEEDBACK/OTHER
  description     TEXT,
  photo_s3_key    TEXT,
  voice_s3_key    TEXT,
  status          complaint_status NOT NULL DEFAULT 'OPEN',
  priority        TEXT NOT NULL DEFAULT 'NORMAL', -- LOW/NORMAL/HIGH
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_farmer ON complaints(farmer_id);

-- Status / assignment / note history per complaint (timeline).
CREATE TABLE IF NOT EXISTS complaint_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,                    -- CREATED/ASSIGNED/STATUS/NOTE
  detail        TEXT,
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaint_events ON complaint_events(complaint_id, created_at);

-- ─────────────────────────────────────────────────────────────
-- PHASE 2 · MULTI-LANGUAGE MANAGEMENT  (PRD §9.2)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_languages (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  native_name  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS translations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  str_key     TEXT NOT NULL,
  lang_code   TEXT NOT NULL REFERENCES app_languages(code) ON DELETE CASCADE,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (str_key, lang_code)
);
CREATE INDEX IF NOT EXISTS idx_translations_key ON translations(str_key);

-- Machine-translation cache: dynamic DATA strings (product names, advisories,
-- crop/disease, weather…) translated once via Gemini, then served from here.
CREATE TABLE IF NOT EXISTS mt_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash  TEXT NOT NULL,            -- sha256(source_text)
  lang_code    TEXT NOT NULL,
  source_text  TEXT NOT NULL,
  translated   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_hash, lang_code)
);

-- Seed the 9 Indian languages + English (PRD §9.2).
INSERT INTO app_languages (code, name, native_name, is_default, sort_order) VALUES
  ('en','English','English',TRUE,0),
  ('hi','Hindi','हिन्दी',FALSE,1),
  ('mr','Marathi','मराठी',FALSE,2),
  ('pa','Punjabi','ਪੰਜਾਬੀ',FALSE,3),
  ('gu','Gujarati','ગુજરાતી',FALSE,4),
  ('bn','Bengali','বাংলা',FALSE,5),
  ('ta','Tamil','தமிழ்',FALSE,6),
  ('te','Telugu','తెలుగు',FALSE,7),
  ('kn','Kannada','ಕನ್ನಡ',FALSE,8),
  ('ml','Malayalam','മലയാളം',FALSE,9)
ON CONFLICT (code) DO NOTHING;

-- A few starter UI string keys (English filled, others blank to translate).
INSERT INTO translations (str_key, lang_code, value)
SELECT k.key, 'en', k.val
FROM (VALUES
  ('app.welcome','Welcome'),
  ('dashboard.title','Dashboard'),
  ('aiDoctor.title','AI Crop Doctor'),
  ('weather.title','Weather'),
  ('rewards.title','My Rewards'),
  ('complaint.raise','Raise a Complaint')
) AS k(key, val)
ON CONFLICT (str_key, lang_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- PROCUREMENT / PURCHASE  — supply side: vendors, PO → GRN → bill → payment.
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS po_seq START 1;
CREATE SEQUENCE IF NOT EXISTS grn_seq START 1;
CREATE SEQUENCE IF NOT EXISTS pbill_seq START 1;

CREATE TABLE IF NOT EXISTS vendors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  gstin          TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  outstanding    NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendors_name_trgm ON vendors USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no         TEXT UNIQUE NOT NULL,
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT/APPROVED/PARTIAL/RECEIVED/CANCELLED
  order_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  sub_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name  TEXT NOT NULL,
  hsn_code      TEXT,
  uom           TEXT,
  quantity      NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  received_qty  NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_cost     NUMERIC(12,2) NOT NULL,
  gst_percent   NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_lines ON purchase_order_lines(po_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_no        TEXT UNIQUE NOT NULL,
  po_id         UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  vendor_id     UUID REFERENCES vendors(id) ON DELETE SET NULL,
  warehouse_id  UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no       TEXT NOT NULL,                  -- vendor's invoice number
  internal_no   TEXT UNIQUE NOT NULL,
  po_id         UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  invoice_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  taxable_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid   NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pinv_vendor ON purchase_invoices(vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  purchase_invoice_id UUID REFERENCES purchase_invoices(id) ON DELETE SET NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method        TEXT,
  reference     TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vpay_vendor ON vendor_payments(vendor_id, paid_at DESC);

-- ─────────────────────────────────────────────────────────────
-- MANUFACTURING ERP  — BOM → production order → consume raw → produce finished + QC (PRD §5).
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS prod_seq START 1;

-- Bill of Materials: recipe to produce `output_quantity` units of a finished product.
CREATE TABLE IF NOT EXISTS bom (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  output_quantity NUMERIC(14,2) NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
  version         INT NOT NULL DEFAULT 1,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bom_product ON bom(product_id);

CREATE TABLE IF NOT EXISTS bom_components (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id               UUID NOT NULL REFERENCES bom(id) ON DELETE CASCADE,
  component_product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity             NUMERIC(14,3) NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS idx_bom_components ON bom_components(bom_id);

CREATE TABLE IF NOT EXISTS production_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prod_no           TEXT UNIQUE NOT NULL,
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  bom_id            UUID REFERENCES bom(id) ON DELETE SET NULL,
  warehouse_id      UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  planned_quantity  NUMERIC(14,2) NOT NULL CHECK (planned_quantity > 0),
  produced_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PLANNED',  -- PLANNED/IN_PROGRESS/COMPLETED/CANCELLED
  qc_status         TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/PASS/FAIL/HOLD
  qc_notes          TEXT,
  batch_number      TEXT,
  mfg_date          DATE,
  expiry_date       DATE,
  notes             TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_prod_status ON production_orders(status, created_at DESC);

-- Audit of raw materials actually consumed per production order (traceability).
CREATE TABLE IF NOT EXISTS production_consumptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id  UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  component_product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id             UUID REFERENCES batches(id) ON DELETE SET NULL,
  quantity             NUMERIC(14,3) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod_consumption ON production_consumptions(production_order_id);

-- ── Manufacturing robustness: multi-level BOM costing, labour/overhead, QC/COA ──
ALTER TABLE products          ADD COLUMN IF NOT EXISTS standard_cost NUMERIC(12,2) NOT NULL DEFAULT 0;  -- per-unit input cost (BOM costing basis)
ALTER TABLE bom               ADD COLUMN IF NOT EXISTS labour_cost   NUMERIC(12,2) NOT NULL DEFAULT 0;   -- per output batch
ALTER TABLE bom               ADD COLUMN IF NOT EXISTS overhead_cost NUMERIC(12,2) NOT NULL DEFAULT 0;   -- per output batch
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS coa_no        TEXT;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS analyst       TEXT;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS approved_by   TEXT;
CREATE SEQUENCE IF NOT EXISTS coa_seq START 1;

-- Structured QC results per production order (a Certificate of Analysis is rendered from these).
CREATE TABLE IF NOT EXISTS production_qc_tests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  parameter           TEXT NOT NULL,            -- e.g. "Active ingredient %", "pH", "Moisture %"
  specification       TEXT,                     -- acceptance spec, e.g. "48-52%"
  result              TEXT,                     -- observed value
  status              TEXT NOT NULL DEFAULT 'PASS',  -- PASS/FAIL
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qc_tests ON production_qc_tests(production_order_id);

-- ─────────────────────────────────────────────────────────────
-- PHASE 3 — AI LAYER  (PRD §9.4-9.5, §11.3): Crop Doctor, Smart Advisory, CRM leads.
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS diag_seq START 1;
CREATE SEQUENCE IF NOT EXISTS lead_seq START 1;
CREATE SEQUENCE IF NOT EXISTS adv_seq  START 1;

-- AI Crop Doctor sessions: a photo -> disease/pest detection.
CREATE TABLE IF NOT EXISTS crop_diagnoses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_no       TEXT UNIQUE NOT NULL,
  farmer_id        UUID REFERENCES farmers(id) ON DELETE SET NULL,
  crop             TEXT NOT NULL,
  image_url        TEXT,
  detected_disease TEXT,
  pathogen         TEXT,
  confidence       NUMERIC(5,2),               -- 0-100
  severity         TEXT,                        -- LOW/MEDIUM/HIGH
  symptoms         TEXT,
  recommendation   TEXT,
  product_ids      UUID[] NOT NULL DEFAULT '{}',
  source           TEXT NOT NULL DEFAULT 'mock',  -- gemini/mock
  gps_lat          NUMERIC(9,6),
  gps_lng          NUMERIC(9,6),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_diag_created ON crop_diagnoses(created_at DESC);

-- Smart Advisory: preventive/curative guidance, optionally tied to a diagnosis.
CREATE TABLE IF NOT EXISTS advisories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advisory_no      TEXT UNIQUE NOT NULL,
  diagnosis_id     UUID REFERENCES crop_diagnoses(id) ON DELETE SET NULL,
  farmer_id        UUID REFERENCES farmers(id) ON DELETE SET NULL,
  crop             TEXT NOT NULL,
  disease          TEXT,
  type             TEXT NOT NULL DEFAULT 'CURATIVE',  -- PREVENTIVE/CURATIVE
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  product_ids      UUID[] NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'DRAFT',     -- DRAFT/SENT/READ
  source           TEXT NOT NULL DEFAULT 'mock',
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_advisory_created ON advisories(created_at DESC);

-- CRM lead auto-generated from an AI Crop Doctor session (PRD §9.4).
CREATE TABLE IF NOT EXISTS crm_leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_no          TEXT UNIQUE NOT NULL,
  diagnosis_id     UUID REFERENCES crop_diagnoses(id) ON DELETE SET NULL,
  farmer_id        UUID REFERENCES farmers(id) ON DELETE SET NULL,
  crop             TEXT,
  disease          TEXT,
  product_ids      UUID[] NOT NULL DEFAULT '{}',
  prior_purchase   BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_to      UUID REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'NEW',       -- NEW/CONTACTED/CONVERTED/LOST
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON crm_leads(status, created_at DESC);

-- ── Train AI Doctor: curated, labelled reference library (few-shot grounding) ──
CREATE SEQUENCE IF NOT EXISTS aiclass_seq START 1;

-- One disease/condition "class" the AI learns to recognise for a crop.
CREATE TABLE IF NOT EXISTS ai_training_classes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_no      TEXT UNIQUE NOT NULL,
  crop          TEXT NOT NULL,
  disease       TEXT NOT NULL,
  pathogen      TEXT,
  description   TEXT,
  symptoms      TEXT,
  treatment     TEXT,
  product_ids   UUID[] NOT NULL DEFAULT '{}',   -- products to recommend when this class is detected
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aiclass_crop ON ai_training_classes(crop);

-- Up to 20 example photos per class. image_url may be an https or a data: URL.
CREATE TABLE IF NOT EXISTS ai_training_samples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      UUID NOT NULL REFERENCES ai_training_classes(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  image_key     TEXT,                            -- S3 object key when stored in S3
  caption       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aisample_class ON ai_training_samples(class_id);
-- Retrieval embedding (Gemini) for RAG diagnosis: vector + the vision caption it was built from.
ALTER TABLE ai_training_samples ADD COLUMN IF NOT EXISTS embedding JSONB;
ALTER TABLE ai_training_samples ADD COLUMN IF NOT EXISTS vision_caption TEXT;

-- ─────────────────────────────────────────────────────────────
-- RETURNS MANAGEMENT  (PRD §7.3): sales returns (→ credit note + restock) and
-- purchase returns (→ debit note + stock-out).
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS srn_seq START 1;
CREATE SEQUENCE IF NOT EXISTS prn_seq START 1;

-- Migrate away from the early single-line stub (product_id/quantity, no distributor_id).
-- Only drops when the OLD shape is present, so it is safe to re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_returns' AND column_name='product_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_returns' AND column_name='distributor_id')
  THEN
    DROP TABLE sales_returns CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sales_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no      TEXT UNIQUE NOT NULL,
  order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
  distributor_id UUID NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  warehouse_id   UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT',   -- DRAFT/APPROVED/CANCELLED
  return_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reason         TEXT,
  sub_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_note_no TEXT,                            -- issued on approval (reduces distributor outstanding)
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sret_dist ON sales_returns(distributor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_return_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  batch_number TEXT,
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL,
  gst_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sret_lines ON sales_return_lines(return_id);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no      TEXT UNIQUE NOT NULL,
  po_id          UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  warehouse_id   UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT',
  return_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reason         TEXT,
  sub_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  debit_note_no  TEXT,                            -- issued on approval (reduces vendor payable)
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pret_vendor ON purchase_returns(vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  batch_number TEXT,
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  unit_cost    NUMERIC(12,2) NOT NULL,
  gst_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pret_lines ON purchase_return_lines(return_id);

-- ─────────────────────────────────────────────────────────────
-- PARTIES — unified counterparties (distributors + farmers + vendors) with a
-- direct "sell any product to anyone" channel. The party LEDGER aggregates from
-- existing modules (invoices, payments, notes, purchase bills, returns) + these.
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS psale_seq START 1;

CREATE TABLE IF NOT EXISTS party_sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_no        TEXT UNIQUE NOT NULL,
  party_type     TEXT NOT NULL,                   -- DISTRIBUTOR / FARMER
  distributor_id UUID REFERENCES distributors(id) ON DELETE SET NULL,
  farmer_id      UUID REFERENCES farmers(id) ON DELETE SET NULL,
  warehouse_id   UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  sale_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  sub_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid    NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ( (party_type = 'DISTRIBUTOR' AND distributor_id IS NOT NULL)
       OR (party_type = 'FARMER' AND farmer_id IS NOT NULL) )
);
CREATE INDEX IF NOT EXISTS idx_psale_dist ON party_sales(distributor_id);
CREATE INDEX IF NOT EXISTS idx_psale_farmer ON party_sales(farmer_id);

CREATE TABLE IF NOT EXISTS party_sale_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      UUID NOT NULL REFERENCES party_sales(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  batch_number TEXT,
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL,
  gst_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psale_lines ON party_sale_lines(sale_id);

-- ── Generic order customer: orders/invoices/payments can target a distributor OR a farmer ──
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'DISTRIBUTOR';
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS farmer_id UUID REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE orders   ALTER COLUMN distributor_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'DISTRIBUTOR';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS farmer_id UUID REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE invoices ALTER COLUMN distributor_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS farmer_id UUID REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE payments ALTER COLUMN distributor_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_farmer ON orders(farmer_id);

-- ── Transport & logistics details (printed on GST + Non-GST invoices/bills) ──
-- Captured at order time and editable later (e.g. at dispatch). `delivery_address`
-- already exists above. Invoices inherit these from their parent order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_name    TEXT;          -- carrier / "Transport"
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transporter_id    TEXT;          -- GST transporter ID
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vehicle_no        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_name       TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_mobile     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lr_number         TEXT;          -- LR / GR-RR No.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lr_date           DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_date     DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_location TEXT;          -- destination station/city
ALTER TABLE orders ADD COLUMN IF NOT EXISTS eway_bill_no      TEXT;          -- manual E-Way Bill No. (GST)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS num_packages      INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_weight      TEXT;          -- free-text to allow units (e.g. "190 Kg")
ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_charges   NUMERIC(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_type      TEXT;          -- PAID / TO_PAY
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_through  TEXT;

-- ─────────────────────────────────────────────────────────────
-- WHATSAPP CAMPAIGN CONSOLE (Phase 4) — broadcast product cards / advisories /
-- offers to farmers & distributors. Provider-abstracted (Meta Cloud API / mock).
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS wacamp_seq START 1;

CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_no      TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  audience         TEXT NOT NULL,                 -- FARMERS / DISTRIBUTORS / ALL
  message_type     TEXT NOT NULL DEFAULT 'TEXT',  -- TEXT / PRODUCT / ADVISORY
  body             TEXT NOT NULL,
  product_id       UUID REFERENCES products(id) ON DELETE SET NULL,
  image_url        TEXT,
  status           TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT / SENT
  recipients_count INT NOT NULL DEFAULT 0,
  sent_count       INT NOT NULL DEFAULT 0,
  failed_count     INT NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES whatsapp_campaigns(id) ON DELETE CASCADE,
  party_type   TEXT,
  party_id     UUID,
  name         TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'QUEUED',    -- SENT / FAILED / SKIPPED
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wamsg_campaign ON whatsapp_messages(campaign_id);

-- ── Farmer App authentication: farmers can self-sign-up (email/Google) or be
-- created by admin. Same farmers table = one source of truth. ──
ALTER TABLE farmers ALTER COLUMN phone DROP NOT NULL; -- app sign-ups may register with email only
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'ADMIN'; -- ADMIN / EMAIL / GOOGLE
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS photo_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_farmers_email_lower ON farmers (lower(email)) WHERE email IS NOT NULL;

-- ── Geolocation + buy-intent enquiries (distributor map + farmer "Buy") ──
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(10,7);
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(10,7);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(10,7);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(10,7);
-- Admin toggle: when false, farmer buy-intents route to the company only (no distributor suggestion).
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS distributor_suggestion BOOLEAN NOT NULL DEFAULT TRUE;

CREATE SEQUENCE IF NOT EXISTS enquiry_seq START 1;
CREATE TABLE IF NOT EXISTS purchase_enquiries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_no     TEXT UNIQUE NOT NULL,
  farmer_id      UUID REFERENCES farmers(id) ON DELETE SET NULL,
  product_id     UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name   TEXT NOT NULL,
  distributor_id UUID REFERENCES distributors(id) ON DELETE SET NULL,  -- nearest (null if suggestion off)
  distance_km    NUMERIC(8,2),
  status         TEXT NOT NULL DEFAULT 'NEW',   -- NEW / CONTACTED / CONVERTED / CLOSED
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enquiry_status ON purchase_enquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiry_distributor ON purchase_enquiries(distributor_id);

-- ── Loyalty referral + redemption/settlement ──
ALTER TABLE orders ADD COLUMN IF NOT EXISTS farmer_ref TEXT; -- FARMER-CODE credited with loyalty coins on this order

CREATE SEQUENCE IF NOT EXISTS redemption_seq START 1;
CREATE TABLE IF NOT EXISTS redemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_no  TEXT UNIQUE NOT NULL,
  farmer_id      UUID NOT NULL REFERENCES farmers(id) ON DELETE RESTRICT,
  points         INT NOT NULL CHECK (points > 0),
  value          NUMERIC(12,2) NOT NULL DEFAULT 0,   -- ₹ the company owes (₹1/coin)
  distributor_id UUID REFERENCES distributors(id) ON DELETE SET NULL, -- who honored it (for settlement)
  channel        TEXT NOT NULL DEFAULT 'ADMIN',      -- ADMIN / DISTRIBUTOR / APP
  note           TEXT,
  settled        BOOLEAN NOT NULL DEFAULT FALSE,     -- has the company reimbursed the distributor
  settled_at     TIMESTAMPTZ,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redemption_distributor ON redemptions(distributor_id, settled);
CREATE INDEX IF NOT EXISTS idx_redemption_farmer ON redemptions(farmer_id, created_at DESC);

-- ── Distributor App authentication: distributors are created by admin (with an
-- email); they sign in to the Distributor App with Google. Only an email that
-- already exists on an active distributor row may log in (no self-signup). ──
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'ADMIN'; -- ADMIN / GOOGLE
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS fcm_token TEXT; -- Distributor App device token (push)
CREATE UNIQUE INDEX IF NOT EXISTS idx_distributors_email_lower ON distributors (lower(email)) WHERE email IS NOT NULL;

-- Crop diagnoses can now originate from the Distributor App too (distributor-scoped history).
ALTER TABLE crop_diagnoses ADD COLUMN IF NOT EXISTS distributor_id UUID REFERENCES distributors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_diag_distributor ON crop_diagnoses(distributor_id, created_at DESC);

-- Distributor App: bills a distributor raises to farmers (their own resale / point-of-sale).
-- Self-contained — does NOT touch company warehouse stock or company receivables.
CREATE SEQUENCE IF NOT EXISTS dist_sale_seq START 1;
CREATE TABLE IF NOT EXISTS distributor_sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no        TEXT UNIQUE NOT NULL,
  distributor_id UUID NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,  -- the seller
  farmer_id      UUID REFERENCES farmers(id) ON DELETE SET NULL,               -- buyer (if a known farmer)
  buyer_name     TEXT NOT NULL,
  buyer_phone    TEXT,
  bill_type      TEXT NOT NULL DEFAULT 'GST',   -- GST (tax invoice) / NON_GST (bill of supply)
  sale_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  sub_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid    NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_distsale_distributor ON distributor_sales(distributor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS distributor_sale_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      UUID NOT NULL REFERENCES distributor_sales(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL,
  gst_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_distsale_lines ON distributor_sale_lines(sale_id);

-- ─────────────────────────────────────────────────────────────
-- FINANCIAL STATEMENTS — manual adjustments ledger.
-- The Balance Sheet / Profit & Loss module derives most figures live from the
-- commerce tables (sales, purchases, stock, GST, debtors, creditors). This one
-- table records the accounts the transactional schema does NOT track — operating
-- expenses, other income, capital, drawings, loans, fixed assets + depreciation,
-- provisions, cash/bank balances, opening balances — so the statements are fully
-- populated from real data (no hardcoded figures). One generic row shape covers
-- every section; `meta` holds schedule sub-fields (fixed-asset opening/addition/
-- depreciation, bank account no, etc.). The Notes/CA-attestation block is stored
-- as a single (statement='BS', section='NOTE') row whose text lives in `meta`.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date  DATE NOT NULL DEFAULT CURRENT_DATE,    -- posting date (period filter)
  statement   TEXT NOT NULL,                          -- TRADING | PL | BS
  section     TEXT NOT NULL,                          -- DIRECT_EXPENSE|INDIRECT_EXPENSE|OTHER_INCOME|
                                                       -- CAPITAL|UNSECURED_LOAN|CURRENT_LIABILITY|PROVISION|
                                                       -- FIXED_ASSET|BANK|CASH|LOAN_ADVANCE|OTHER_ASSET|
                                                       -- OTHER_LIABILITY|OPENING_STOCK|NOTE
  label       TEXT NOT NULL,                          -- line label as shown on the statement
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,       -- closing value for the line
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {opening,addition,depreciation,rate,accountNo,policies,...}
  is_gst      BOOLEAN NOT NULL DEFAULT TRUE,          -- honoured by the GST-only filter
  notes       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fle_date ON financial_ledger_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_fle_section ON financial_ledger_entries(statement, section);

-- ============================================================================
-- End of schema (… + geo/enquiries + loyalty redemption + distributor app
--                + financial statements adjustments ledger)
-- ============================================================================
