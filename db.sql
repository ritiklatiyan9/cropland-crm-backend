-- ─────────────────────────────────────────────────────────────
-- Schema dump generated from the live database.
-- Generated: 2026-06-29T11:28:08.086Z
-- Restore into an empty DB:  psql "$URL" -f db.sql
-- ─────────────────────────────────────────────────────────────

SET client_min_messages = warning;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum types
DO $$ BEGIN
  CREATE TYPE complaint_status AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE loyalty_txn_type AS ENUM ('EARN', 'REDEEM', 'BONUS', 'ADJUST');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('DRAFT', 'PLACED', 'APPROVED', 'INVOICED', 'DISPATCHED', 'DELIVERED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE product_category AS ENUM ('PESTICIDE', 'FERTILIZER', 'SEED', 'HERBICIDE', 'FUNGICIDE', 'INSECTICIDE', 'BIO_PRODUCT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES', 'DISTRIBUTOR', 'FARMER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Sequences
CREATE SEQUENCE IF NOT EXISTS adv_seq;
CREATE SEQUENCE IF NOT EXISTS aiclass_seq;
CREATE SEQUENCE IF NOT EXISTS coa_seq;
CREATE SEQUENCE IF NOT EXISTS complaint_seq;
CREATE SEQUENCE IF NOT EXISTS diag_seq;
CREATE SEQUENCE IF NOT EXISTS dist_sale_seq;
CREATE SEQUENCE IF NOT EXISTS enquiry_seq;
CREATE SEQUENCE IF NOT EXISTS grn_seq;
CREATE SEQUENCE IF NOT EXISTS invoice_seq;
CREATE SEQUENCE IF NOT EXISTS lead_seq;
CREATE SEQUENCE IF NOT EXISTS note_seq;
CREATE SEQUENCE IF NOT EXISTS order_seq;
CREATE SEQUENCE IF NOT EXISTS pbill_seq;
CREATE SEQUENCE IF NOT EXISTS po_seq;
CREATE SEQUENCE IF NOT EXISTS prn_seq;
CREATE SEQUENCE IF NOT EXISTS prod_seq;
CREATE SEQUENCE IF NOT EXISTS psale_seq;
CREATE SEQUENCE IF NOT EXISTS redemption_seq;
CREATE SEQUENCE IF NOT EXISTS srn_seq;
CREATE SEQUENCE IF NOT EXISTS wacamp_seq;

-- Tables
CREATE TABLE IF NOT EXISTS activity_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  action text NOT NULL,
  entity text,
  entity_id uuid,
  ip_address inet,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS advisories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  advisory_no text NOT NULL,
  diagnosis_id uuid,
  farmer_id uuid,
  crop text NOT NULL,
  disease text,
  type text DEFAULT 'CURATIVE'::text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  product_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  status text DEFAULT 'DRAFT'::text NOT NULL,
  source text DEFAULT 'mock'::text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  sent_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS ai_training_classes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  class_no text NOT NULL,
  crop text NOT NULL,
  disease text NOT NULL,
  pathogen text,
  description text,
  symptoms text,
  treatment text,
  product_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_training_samples (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  class_id uuid NOT NULL,
  image_url text NOT NULL,
  image_key text,
  caption text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  embedding jsonb,
  vision_caption text
);

CREATE TABLE IF NOT EXISTS app_languages (
  code text NOT NULL,
  name text NOT NULL,
  native_name text,
  is_active boolean DEFAULT true NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_number text NOT NULL,
  product_id uuid NOT NULL,
  manufacturing_date date,
  expiry_date date,
  qc_status text DEFAULT 'PASSED'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS bom (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid NOT NULL,
  output_quantity numeric(14,2) DEFAULT 1 NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  labour_cost numeric(12,2) DEFAULT 0 NOT NULL,
  overhead_cost numeric(12,2) DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS bom_components (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bom_id uuid NOT NULL,
  component_product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  code text,
  state text,
  district text,
  address text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS company_settings (
  id integer DEFAULT 1 NOT NULL,
  legal_name text DEFAULT 'Cropland Agro Pvt. Ltd.'::text NOT NULL,
  trade_name text,
  gstin text,
  pan text,
  cin text,
  email text,
  phone text,
  website text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  pincode text,
  logo_key text,
  bank_name text,
  bank_account text,
  bank_ifsc text,
  bank_branch text,
  invoice_prefix text DEFAULT 'INV'::text NOT NULL,
  invoice_terms text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  gps_lat numeric(10,7),
  gps_lng numeric(10,7),
  distributor_suggestion boolean DEFAULT true NOT NULL,
  gst_api_provider text,
  gst_api_base_url text,
  gst_api_client_id text,
  gst_api_username text,
  gst_api_key text,
  gst_api_secret text,
  gst_api_password text,
  gst_api_enabled boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS complaint_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  complaint_id uuid NOT NULL,
  event_type text NOT NULL,
  detail text,
  actor_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS complaints (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_no text NOT NULL,
  farmer_id uuid,
  distributor_id uuid,
  category text NOT NULL,
  description text,
  photo_s3_key text,
  voice_s3_key text,
  status complaint_status DEFAULT 'OPEN'::complaint_status NOT NULL,
  priority text DEFAULT 'NORMAL'::text NOT NULL,
  assigned_to uuid,
  resolution_note text,
  resolved_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_debit_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  note_no text NOT NULL,
  distributor_id uuid NOT NULL,
  note_type text NOT NULL,
  amount numeric(14,2) NOT NULL,
  reason text,
  ref_invoice_id uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  taxable_value numeric(14,2),
  gst_rate numeric(5,2),
  cgst numeric(14,2) DEFAULT 0 NOT NULL,
  sgst numeric(14,2) DEFAULT 0 NOT NULL,
  igst numeric(14,2) DEFAULT 0 NOT NULL,
  is_interstate boolean DEFAULT false NOT NULL,
  note_reason text
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  lead_no text NOT NULL,
  diagnosis_id uuid,
  farmer_id uuid,
  crop text,
  disease text,
  product_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  prior_purchase boolean DEFAULT false NOT NULL,
  assigned_to uuid,
  status text DEFAULT 'NEW'::text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS crop_diagnoses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_no text NOT NULL,
  farmer_id uuid,
  crop text NOT NULL,
  image_url text,
  detected_disease text,
  pathogen text,
  confidence numeric(5,2),
  severity text,
  symptoms text,
  recommendation text,
  product_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  source text DEFAULT 'mock'::text NOT NULL,
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  distributor_id uuid
);

CREATE TABLE IF NOT EXISTS distributor_sale_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sale_id uuid NOT NULL,
  product_id uuid,
  product_name text NOT NULL,
  quantity numeric(14,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS distributor_sales (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bill_no text NOT NULL,
  distributor_id uuid NOT NULL,
  farmer_id uuid,
  buyer_name text NOT NULL,
  buyer_phone text,
  bill_type text DEFAULT 'GST'::text NOT NULL,
  sale_date date DEFAULT CURRENT_DATE NOT NULL,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  amount_paid numeric(14,2) DEFAULT 0 NOT NULL,
  payment_method text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS distributors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  name text NOT NULL,
  contact_person text,
  phone text,
  email text,
  gstin text,
  dealer_tier text,
  state text,
  district text,
  address text,
  branch_id uuid,
  credit_limit numeric(14,2) DEFAULT 0 NOT NULL,
  outstanding numeric(14,2) DEFAULT 0 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  gps_lat numeric(10,7),
  gps_lng numeric(10,7),
  auth_provider text DEFAULT 'ADMIN'::text NOT NULL,
  google_id text,
  photo_url text,
  language text DEFAULT 'en'::text,
  fcm_token text,
  udyam_no text,
  msme_type text,
  msme_registered boolean DEFAULT false NOT NULL,
  msme_reg_date date
);

CREATE TABLE IF NOT EXISTS e_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_id uuid NOT NULL,
  irn text,
  ack_no text,
  ack_date timestamp with time zone,
  signed_qr text,
  signed_invoice text,
  status text DEFAULT 'GENERATED'::text NOT NULL,
  provider text DEFAULT 'mock'::text NOT NULL,
  cancel_reason text,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS eway_bills (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_id uuid NOT NULL,
  ewb_no text,
  ewb_date timestamp with time zone,
  valid_until timestamp with time zone,
  distance_km integer,
  transport_mode text,
  vehicle_no text,
  transporter_id text,
  status text DEFAULT 'GENERATED'::text NOT NULL,
  provider text DEFAULT 'mock'::text NOT NULL,
  cancel_reason text,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS farmers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  farmer_code text NOT NULL,
  name text NOT NULL,
  phone text,
  village text,
  tehsil text,
  district text,
  state text,
  crops text[] DEFAULT '{}'::text[] NOT NULL,
  land_size_acres numeric(10,2),
  language text DEFAULT 'en'::text,
  points_balance integer DEFAULT 0 NOT NULL,
  registered_by uuid,
  fcm_token text,
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  email text,
  password_hash text,
  auth_provider text DEFAULT 'ADMIN'::text NOT NULL,
  google_id text,
  photo_url text,
  deletion_status text,
  deletion_requested_at timestamp with time zone,
  deletion_reason text
);

CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entry_date date DEFAULT CURRENT_DATE NOT NULL,
  statement text NOT NULL,
  section text NOT NULL,
  label text NOT NULL,
  amount numeric(14,2) DEFAULT 0 NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_gst boolean DEFAULT true NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  grn_no text NOT NULL,
  po_id uuid,
  vendor_id uuid,
  warehouse_id uuid,
  received_date date DEFAULT CURRENT_DATE NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS gst_challans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cpin text,
  challan_no text,
  period text,
  paid_date date,
  igst numeric(14,2) DEFAULT 0 NOT NULL,
  cgst numeric(14,2) DEFAULT 0 NOT NULL,
  sgst numeric(14,2) DEFAULT 0 NOT NULL,
  cess numeric(14,2) DEFAULT 0 NOT NULL,
  fees numeric(14,2) DEFAULT 0 NOT NULL,
  interest numeric(14,2) DEFAULT 0 NOT NULL,
  amount numeric(14,2) DEFAULT 0 NOT NULL,
  mode text,
  status text DEFAULT 'PAID'::text NOT NULL,
  import_id uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS gst_recon_docs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  import_id uuid NOT NULL,
  source text NOT NULL,
  period text NOT NULL,
  ctin text,
  trade_name text,
  doc_type text DEFAULT 'INV'::text NOT NULL,
  doc_no text,
  doc_date date,
  taxable numeric(14,2) DEFAULT 0 NOT NULL,
  igst numeric(14,2) DEFAULT 0 NOT NULL,
  cgst numeric(14,2) DEFAULT 0 NOT NULL,
  sgst numeric(14,2) DEFAULT 0 NOT NULL,
  cess numeric(14,2) DEFAULT 0 NOT NULL,
  total numeric(14,2) DEFAULT 0 NOT NULL,
  itc_eligible boolean,
  match_status text DEFAULT 'PORTAL_ONLY'::text NOT NULL,
  matched_purchase_id uuid,
  ims_action text,
  ims_acted_by uuid,
  ims_acted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  match_score numeric(5,2),
  match_reason text,
  note text,
  manual_match boolean DEFAULT false NOT NULL,
  itc_action text
);

CREATE TABLE IF NOT EXISTS gst_recon_imports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source text NOT NULL,
  period text NOT NULL,
  gstin text,
  file_name text,
  raw jsonb,
  line_count integer DEFAULT 0 NOT NULL,
  uploaded_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS gst_returns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  return_type text NOT NULL,
  period text NOT NULL,
  gstin text,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  summary jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'GENERATED'::text NOT NULL,
  filed_ref text,
  generated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_no text NOT NULL,
  order_id uuid NOT NULL,
  distributor_id uuid,
  invoice_date date DEFAULT CURRENT_DATE NOT NULL,
  place_of_supply text,
  is_interstate boolean DEFAULT false NOT NULL,
  taxable_value numeric(14,2) DEFAULT 0 NOT NULL,
  cgst numeric(14,2) DEFAULT 0 NOT NULL,
  sgst numeric(14,2) DEFAULT 0 NOT NULL,
  igst numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  amount_paid numeric(14,2) DEFAULT 0 NOT NULL,
  irn text,
  eway_bill_no text,
  status text DEFAULT 'ISSUED'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  bill_type text DEFAULT 'GST'::text NOT NULL,
  customer_type text DEFAULT 'DISTRIBUTOR'::text NOT NULL,
  farmer_id uuid
);

CREATE TABLE IF NOT EXISTS loyalty_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  rule_type text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  valid_from date,
  valid_to date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  farmer_id uuid NOT NULL,
  points integer NOT NULL,
  type loyalty_txn_type NOT NULL,
  note text,
  ref_order_id uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS mt_cache (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_hash text NOT NULL,
  lang_code text NOT NULL,
  source_text text NOT NULL,
  translated text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  audience text NOT NULL,
  channels text[] DEFAULT '{}'::text[] NOT NULL,
  campaign_type text,
  title text NOT NULL,
  body text NOT NULL,
  target_user_id uuid,
  target_farmer_id uuid,
  status text DEFAULT 'QUEUED'::text NOT NULL,
  result jsonb DEFAULT '{}'::jsonb NOT NULL,
  recipients integer DEFAULT 0 NOT NULL,
  created_by uuid,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  hsn_code text,
  uom text,
  quantity numeric(14,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  discount_pct numeric(5,2) DEFAULT 0 NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  order_no text NOT NULL,
  distributor_id uuid,
  status order_status DEFAULT 'PLACED'::order_status NOT NULL,
  order_date date DEFAULT CURRENT_DATE NOT NULL,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  discount_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  notes text,
  delivery_address text,
  approved_by uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  bill_type text DEFAULT 'GST'::text NOT NULL,
  customer_type text DEFAULT 'DISTRIBUTOR'::text NOT NULL,
  farmer_id uuid,
  farmer_ref text,
  transport_name text,
  transporter_id text,
  vehicle_no text,
  driver_name text,
  driver_mobile text,
  lr_number text,
  lr_date date,
  dispatch_date date,
  delivery_location text,
  eway_bill_no text,
  num_packages integer,
  total_weight text,
  freight_charges numeric(14,2),
  freight_type text,
  dispatch_through text,
  bill_address jsonb
);

CREATE TABLE IF NOT EXISTS party_sale_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sale_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  batch_number text,
  quantity numeric(14,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS party_sales (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sale_no text NOT NULL,
  party_type text NOT NULL,
  distributor_id uuid,
  farmer_id uuid,
  warehouse_id uuid,
  sale_date date DEFAULT CURRENT_DATE NOT NULL,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  amount_paid numeric(14,2) DEFAULT 0 NOT NULL,
  payment_method text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_id uuid,
  distributor_id uuid,
  amount numeric(14,2) NOT NULL,
  method text,
  reference text,
  created_by uuid,
  paid_at timestamp with time zone DEFAULT now() NOT NULL,
  farmer_id uuid
);

CREATE TABLE IF NOT EXISTS price_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid NOT NULL,
  scope text DEFAULT 'BASE'::text NOT NULL,
  state text,
  district text,
  dealer_tier text,
  price numeric(12,2) NOT NULL,
  min_quantity integer DEFAULT 1 NOT NULL,
  discount_pct numeric(5,2) DEFAULT 0 NOT NULL,
  valid_from date,
  valid_to date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS production_consumptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  production_order_id uuid NOT NULL,
  component_product_id uuid NOT NULL,
  batch_id uuid,
  quantity numeric(14,3) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS production_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  prod_no text NOT NULL,
  product_id uuid NOT NULL,
  bom_id uuid,
  warehouse_id uuid,
  planned_quantity numeric(14,2) NOT NULL,
  produced_quantity numeric(14,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'PLANNED'::text NOT NULL,
  qc_status text DEFAULT 'PENDING'::text NOT NULL,
  qc_notes text,
  batch_number text,
  mfg_date date,
  expiry_date date,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  coa_no text,
  analyst text,
  approved_by text
);

CREATE TABLE IF NOT EXISTS production_qc_tests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  production_order_id uuid NOT NULL,
  parameter text NOT NULL,
  specification text,
  result text,
  status text DEFAULT 'PASS'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  sku text NOT NULL,
  category product_category DEFAULT 'OTHER'::product_category NOT NULL,
  technical_name text,
  uom text,
  packing_size text,
  hsn_code text,
  gst_percent numeric(5,2),
  mrp numeric(12,2),
  dealer_price numeric(12,2),
  distributor_price numeric(12,2),
  target_crops text[] DEFAULT '{}'::text[] NOT NULL,
  target_diseases text[] DEFAULT '{}'::text[] NOT NULL,
  season_tags text[] DEFAULT '{}'::text[] NOT NULL,
  recommended_dosage text,
  application_frequency text,
  safety_instructions text,
  hazard_category text,
  shelf_life_months integer,
  storage_conditions text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  image_key text,
  standard_cost numeric(12,2) DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_no text NOT NULL,
  farmer_id uuid,
  product_id uuid,
  product_name text NOT NULL,
  distributor_id uuid,
  distance_km numeric(8,2),
  status text DEFAULT 'NEW'::text NOT NULL,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  bill_no text NOT NULL,
  internal_no text NOT NULL,
  po_id uuid,
  vendor_id uuid NOT NULL,
  invoice_date date DEFAULT CURRENT_DATE NOT NULL,
  taxable_value numeric(14,2) DEFAULT 0 NOT NULL,
  tax_value numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  amount_paid numeric(14,2) DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  igst numeric(14,2) DEFAULT 0 NOT NULL,
  cgst numeric(14,2) DEFAULT 0 NOT NULL,
  sgst numeric(14,2) DEFAULT 0 NOT NULL,
  cess numeric(14,2) DEFAULT 0 NOT NULL,
  is_interstate boolean DEFAULT false NOT NULL,
  is_rcm boolean DEFAULT false NOT NULL,
  itc_eligibility text DEFAULT 'ELIGIBLE'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  po_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  hsn_code text,
  uom text,
  quantity numeric(14,2) NOT NULL,
  received_qty numeric(14,2) DEFAULT 0 NOT NULL,
  unit_cost numeric(12,2) NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  po_no text NOT NULL,
  vendor_id uuid NOT NULL,
  status text DEFAULT 'DRAFT'::text NOT NULL,
  order_date date DEFAULT CURRENT_DATE NOT NULL,
  expected_date date,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  return_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  batch_number text,
  quantity numeric(14,2) NOT NULL,
  unit_cost numeric(12,2) NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  return_no text NOT NULL,
  po_id uuid,
  vendor_id uuid NOT NULL,
  warehouse_id uuid,
  status text DEFAULT 'DRAFT'::text NOT NULL,
  return_date date DEFAULT CURRENT_DATE NOT NULL,
  reason text,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  debit_note_no text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  approved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS redemptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  redemption_no text NOT NULL,
  farmer_id uuid NOT NULL,
  points integer NOT NULL,
  value numeric(12,2) DEFAULT 0 NOT NULL,
  distributor_id uuid,
  channel text DEFAULT 'ADMIN'::text NOT NULL,
  note text,
  settled boolean DEFAULT false NOT NULL,
  settled_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  role user_role NOT NULL,
  module text NOT NULL,
  access text DEFAULT 'NONE'::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  can_create boolean DEFAULT false NOT NULL,
  can_read boolean DEFAULT false NOT NULL,
  can_update boolean DEFAULT false NOT NULL,
  can_delete boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_return_lines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  return_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  batch_number text,
  quantity numeric(14,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  gst_percent numeric(5,2) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_returns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  return_no text NOT NULL,
  order_id uuid,
  distributor_id uuid NOT NULL,
  warehouse_id uuid,
  status text DEFAULT 'DRAFT'::text NOT NULL,
  return_date date DEFAULT CURRENT_DATE NOT NULL,
  reason text,
  sub_total numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  credit_note_no text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  approved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS schemes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  scheme_type text DEFAULT 'DISCOUNT'::text NOT NULL,
  description text,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  valid_from date,
  valid_to date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_levels (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity numeric(14,2) DEFAULT 0 NOT NULL,
  reserved numeric(14,2) DEFAULT 0 NOT NULL,
  reorder_level numeric(14,2) DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  movement_type text NOT NULL,
  quantity numeric(14,2) NOT NULL,
  reason text,
  ref_type text,
  ref_id uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS translations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  str_key text NOT NULL,
  lang_code text NOT NULL,
  value text DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  module text NOT NULL,
  can_create boolean DEFAULT false NOT NULL,
  can_read boolean DEFAULT false NOT NULL,
  can_update boolean DEFAULT false NOT NULL,
  can_delete boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  role user_role NOT NULL,
  branch_id uuid,
  password_hash text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  two_factor_enabled boolean DEFAULT false NOT NULL,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  avatar_key text,
  designation text,
  employee_code text,
  gender text,
  date_of_birth date,
  address text,
  city text,
  state text
);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  vendor_id uuid NOT NULL,
  purchase_invoice_id uuid,
  amount numeric(14,2) NOT NULL,
  method text,
  reference text,
  created_by uuid,
  paid_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  contact_person text,
  phone text,
  email text,
  gstin text,
  address text,
  city text,
  state text,
  outstanding numeric(14,2) DEFAULT 0 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  udyam_no text,
  msme_type text,
  msme_registered boolean DEFAULT false NOT NULL,
  msme_reg_date date,
  payment_terms_days integer DEFAULT 45 NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  code text,
  branch_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  campaign_no text NOT NULL,
  name text NOT NULL,
  audience text NOT NULL,
  message_type text DEFAULT 'TEXT'::text NOT NULL,
  body text NOT NULL,
  product_id uuid,
  image_url text,
  status text DEFAULT 'DRAFT'::text NOT NULL,
  recipients_count integer DEFAULT 0 NOT NULL,
  sent_count integer DEFAULT 0 NOT NULL,
  failed_count integer DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  sent_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  campaign_id uuid NOT NULL,
  party_type text,
  party_id uuid,
  name text,
  phone text,
  status text DEFAULT 'QUEUED'::text NOT NULL,
  error text,
  sent_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Primary keys
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);
ALTER TABLE advisories ADD CONSTRAINT advisories_pkey PRIMARY KEY (id);
ALTER TABLE ai_training_classes ADD CONSTRAINT ai_training_classes_pkey PRIMARY KEY (id);
ALTER TABLE ai_training_samples ADD CONSTRAINT ai_training_samples_pkey PRIMARY KEY (id);
ALTER TABLE app_languages ADD CONSTRAINT app_languages_pkey PRIMARY KEY (code);
ALTER TABLE batches ADD CONSTRAINT batches_pkey PRIMARY KEY (id);
ALTER TABLE bom ADD CONSTRAINT bom_pkey PRIMARY KEY (id);
ALTER TABLE bom_components ADD CONSTRAINT bom_components_pkey PRIMARY KEY (id);
ALTER TABLE branches ADD CONSTRAINT branches_pkey PRIMARY KEY (id);
ALTER TABLE company_settings ADD CONSTRAINT company_settings_pkey PRIMARY KEY (id);
ALTER TABLE complaint_events ADD CONSTRAINT complaint_events_pkey PRIMARY KEY (id);
ALTER TABLE complaints ADD CONSTRAINT complaints_pkey PRIMARY KEY (id);
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_pkey PRIMARY KEY (id);
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);
ALTER TABLE crop_diagnoses ADD CONSTRAINT crop_diagnoses_pkey PRIMARY KEY (id);
ALTER TABLE distributor_sale_lines ADD CONSTRAINT distributor_sale_lines_pkey PRIMARY KEY (id);
ALTER TABLE distributor_sales ADD CONSTRAINT distributor_sales_pkey PRIMARY KEY (id);
ALTER TABLE distributors ADD CONSTRAINT distributors_pkey PRIMARY KEY (id);
ALTER TABLE e_invoices ADD CONSTRAINT e_invoices_pkey PRIMARY KEY (id);
ALTER TABLE eway_bills ADD CONSTRAINT eway_bills_pkey PRIMARY KEY (id);
ALTER TABLE farmers ADD CONSTRAINT farmers_pkey PRIMARY KEY (id);
ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_entries_pkey PRIMARY KEY (id);
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_pkey PRIMARY KEY (id);
ALTER TABLE gst_challans ADD CONSTRAINT gst_challans_pkey PRIMARY KEY (id);
ALTER TABLE gst_recon_docs ADD CONSTRAINT gst_recon_docs_pkey PRIMARY KEY (id);
ALTER TABLE gst_recon_imports ADD CONSTRAINT gst_recon_imports_pkey PRIMARY KEY (id);
ALTER TABLE gst_returns ADD CONSTRAINT gst_returns_pkey PRIMARY KEY (id);
ALTER TABLE invoices ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);
ALTER TABLE loyalty_rules ADD CONSTRAINT loyalty_rules_pkey PRIMARY KEY (id);
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);
ALTER TABLE mt_cache ADD CONSTRAINT mt_cache_pkey PRIMARY KEY (id);
ALTER TABLE notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE order_lines ADD CONSTRAINT order_lines_pkey PRIMARY KEY (id);
ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE party_sale_lines ADD CONSTRAINT party_sale_lines_pkey PRIMARY KEY (id);
ALTER TABLE party_sales ADD CONSTRAINT party_sales_pkey PRIMARY KEY (id);
ALTER TABLE payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE price_rules ADD CONSTRAINT price_rules_pkey PRIMARY KEY (id);
ALTER TABLE production_consumptions ADD CONSTRAINT production_consumptions_pkey PRIMARY KEY (id);
ALTER TABLE production_orders ADD CONSTRAINT production_orders_pkey PRIMARY KEY (id);
ALTER TABLE production_qc_tests ADD CONSTRAINT production_qc_tests_pkey PRIMARY KEY (id);
ALTER TABLE products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE purchase_enquiries ADD CONSTRAINT purchase_enquiries_pkey PRIMARY KEY (id);
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_pkey PRIMARY KEY (id);
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id);
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
ALTER TABLE purchase_return_lines ADD CONSTRAINT purchase_return_lines_pkey PRIMARY KEY (id);
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_pkey PRIMARY KEY (id);
ALTER TABLE redemptions ADD CONSTRAINT redemptions_pkey PRIMARY KEY (id);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);
ALTER TABLE sales_return_lines ADD CONSTRAINT sales_return_lines_pkey PRIMARY KEY (id);
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_pkey PRIMARY KEY (id);
ALTER TABLE schemes ADD CONSTRAINT schemes_pkey PRIMARY KEY (id);
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_pkey PRIMARY KEY (id);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);
ALTER TABLE translations ADD CONSTRAINT translations_pkey PRIMARY KEY (id);
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_pkey PRIMARY KEY (id);
ALTER TABLE vendors ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
ALTER TABLE warehouses ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);
ALTER TABLE whatsapp_campaigns ADD CONSTRAINT whatsapp_campaigns_pkey PRIMARY KEY (id);
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);

-- Unique / check / exclusion constraints
ALTER TABLE advisories ADD CONSTRAINT advisories_advisory_no_key UNIQUE (advisory_no);
ALTER TABLE ai_training_classes ADD CONSTRAINT ai_training_classes_class_no_key UNIQUE (class_no);
ALTER TABLE batches ADD CONSTRAINT batches_product_id_batch_number_key UNIQUE (product_id, batch_number);
ALTER TABLE bom ADD CONSTRAINT bom_output_quantity_check CHECK ((output_quantity > (0)::numeric));
ALTER TABLE bom_components ADD CONSTRAINT bom_components_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE branches ADD CONSTRAINT branches_code_key UNIQUE (code);
ALTER TABLE company_settings ADD CONSTRAINT company_settings_id_check CHECK ((id = 1));
ALTER TABLE complaints ADD CONSTRAINT complaints_ticket_no_key UNIQUE (ticket_no);
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_note_no_key UNIQUE (note_no);
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_lead_no_key UNIQUE (lead_no);
ALTER TABLE crop_diagnoses ADD CONSTRAINT crop_diagnoses_session_no_key UNIQUE (session_no);
ALTER TABLE distributor_sale_lines ADD CONSTRAINT distributor_sale_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE distributor_sales ADD CONSTRAINT distributor_sales_bill_no_key UNIQUE (bill_no);
ALTER TABLE e_invoices ADD CONSTRAINT e_invoices_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE eway_bills ADD CONSTRAINT eway_bills_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE farmers ADD CONSTRAINT farmers_farmer_code_key UNIQUE (farmer_code);
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_grn_no_key UNIQUE (grn_no);
ALTER TABLE gst_returns ADD CONSTRAINT gst_returns_return_type_period_key UNIQUE (return_type, period);
ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_no_key UNIQUE (invoice_no);
ALTER TABLE mt_cache ADD CONSTRAINT mt_cache_source_hash_lang_code_key UNIQUE (source_hash, lang_code);
ALTER TABLE order_lines ADD CONSTRAINT order_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE orders ADD CONSTRAINT orders_order_no_key UNIQUE (order_no);
ALTER TABLE party_sale_lines ADD CONSTRAINT party_sale_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE party_sales ADD CONSTRAINT party_sales_check CHECK ((((party_type = 'DISTRIBUTOR'::text) AND (distributor_id IS NOT NULL)) OR ((party_type = 'FARMER'::text) AND (farmer_id IS NOT NULL))));
ALTER TABLE party_sales ADD CONSTRAINT party_sales_sale_no_key UNIQUE (sale_no);
ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE production_orders ADD CONSTRAINT production_orders_planned_quantity_check CHECK ((planned_quantity > (0)::numeric));
ALTER TABLE production_orders ADD CONSTRAINT production_orders_prod_no_key UNIQUE (prod_no);
ALTER TABLE products ADD CONSTRAINT products_sku_key UNIQUE (sku);
ALTER TABLE purchase_enquiries ADD CONSTRAINT purchase_enquiries_enquiry_no_key UNIQUE (enquiry_no);
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_internal_no_key UNIQUE (internal_no);
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_po_no_key UNIQUE (po_no);
ALTER TABLE purchase_return_lines ADD CONSTRAINT purchase_return_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_return_no_key UNIQUE (return_no);
ALTER TABLE redemptions ADD CONSTRAINT redemptions_points_check CHECK ((points > 0));
ALTER TABLE redemptions ADD CONSTRAINT redemptions_redemption_no_key UNIQUE (redemption_no);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_module_key UNIQUE (role, module);
ALTER TABLE sales_return_lines ADD CONSTRAINT sales_return_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_return_no_key UNIQUE (return_no);
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_warehouse_id_product_id_batch_id_key UNIQUE (warehouse_id, product_id, batch_id);
ALTER TABLE translations ADD CONSTRAINT translations_str_key_lang_code_key UNIQUE (str_key, lang_code);
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_user_id_module_key UNIQUE (user_id, module);
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE warehouses ADD CONSTRAINT warehouses_code_key UNIQUE (code);
ALTER TABLE whatsapp_campaigns ADD CONSTRAINT whatsapp_campaigns_campaign_no_key UNIQUE (campaign_no);

-- Foreign keys
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE advisories ADD CONSTRAINT advisories_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE advisories ADD CONSTRAINT advisories_diagnosis_id_fkey FOREIGN KEY (diagnosis_id) REFERENCES crop_diagnoses(id) ON DELETE SET NULL;
ALTER TABLE advisories ADD CONSTRAINT advisories_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE ai_training_classes ADD CONSTRAINT ai_training_classes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ai_training_samples ADD CONSTRAINT ai_training_samples_class_id_fkey FOREIGN KEY (class_id) REFERENCES ai_training_classes(id) ON DELETE CASCADE;
ALTER TABLE batches ADD CONSTRAINT batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE bom ADD CONSTRAINT bom_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bom ADD CONSTRAINT bom_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE bom_components ADD CONSTRAINT bom_components_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES bom(id) ON DELETE CASCADE;
ALTER TABLE bom_components ADD CONSTRAINT bom_components_component_product_id_fkey FOREIGN KEY (component_product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE complaint_events ADD CONSTRAINT complaint_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE complaint_events ADD CONSTRAINT complaint_events_complaint_id_fkey FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE;
ALTER TABLE complaints ADD CONSTRAINT complaints_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD CONSTRAINT complaints_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD CONSTRAINT complaints_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD CONSTRAINT complaints_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE credit_debit_notes ADD CONSTRAINT credit_debit_notes_ref_invoice_id_fkey FOREIGN KEY (ref_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_diagnosis_id_fkey FOREIGN KEY (diagnosis_id) REFERENCES crop_diagnoses(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE crop_diagnoses ADD CONSTRAINT crop_diagnoses_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crop_diagnoses ADD CONSTRAINT crop_diagnoses_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE crop_diagnoses ADD CONSTRAINT crop_diagnoses_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE distributor_sale_lines ADD CONSTRAINT distributor_sale_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE distributor_sale_lines ADD CONSTRAINT distributor_sale_lines_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES distributor_sales(id) ON DELETE CASCADE;
ALTER TABLE distributor_sales ADD CONSTRAINT distributor_sales_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE CASCADE;
ALTER TABLE distributor_sales ADD CONSTRAINT distributor_sales_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE distributors ADD CONSTRAINT distributors_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE distributors ADD CONSTRAINT distributors_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE e_invoices ADD CONSTRAINT e_invoices_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE eway_bills ADD CONSTRAINT eway_bills_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE farmers ADD CONSTRAINT farmers_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE gst_challans ADD CONSTRAINT gst_challans_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE gst_challans ADD CONSTRAINT gst_challans_import_id_fkey FOREIGN KEY (import_id) REFERENCES gst_recon_imports(id) ON DELETE SET NULL;
ALTER TABLE gst_recon_docs ADD CONSTRAINT gst_recon_docs_import_id_fkey FOREIGN KEY (import_id) REFERENCES gst_recon_imports(id) ON DELETE CASCADE;
ALTER TABLE gst_recon_docs ADD CONSTRAINT gst_recon_docs_ims_acted_by_fkey FOREIGN KEY (ims_acted_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE gst_recon_docs ADD CONSTRAINT gst_recon_docs_matched_purchase_id_fkey FOREIGN KEY (matched_purchase_id) REFERENCES purchase_invoices(id) ON DELETE SET NULL;
ALTER TABLE gst_recon_imports ADD CONSTRAINT gst_recon_imports_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE gst_returns ADD CONSTRAINT gst_returns_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD CONSTRAINT invoices_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE CASCADE;
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_ref_order_id_fkey FOREIGN KEY (ref_order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_target_farmer_id_fkey FOREIGN KEY (target_farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD CONSTRAINT orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD CONSTRAINT orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD CONSTRAINT orders_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD CONSTRAINT orders_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE party_sale_lines ADD CONSTRAINT party_sale_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE party_sale_lines ADD CONSTRAINT party_sale_lines_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES party_sales(id) ON DELETE CASCADE;
ALTER TABLE party_sales ADD CONSTRAINT party_sales_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE party_sales ADD CONSTRAINT party_sales_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE party_sales ADD CONSTRAINT party_sales_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE party_sales ADD CONSTRAINT party_sales_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE payments ADD CONSTRAINT payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payments ADD CONSTRAINT payments_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE payments ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE price_rules ADD CONSTRAINT price_rules_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE production_consumptions ADD CONSTRAINT production_consumptions_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE production_consumptions ADD CONSTRAINT production_consumptions_component_product_id_fkey FOREIGN KEY (component_product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE production_consumptions ADD CONSTRAINT production_consumptions_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE CASCADE;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES bom(id) ON DELETE SET NULL;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE production_qc_tests ADD CONSTRAINT production_qc_tests_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE CASCADE;
ALTER TABLE purchase_enquiries ADD CONSTRAINT purchase_enquiries_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE purchase_enquiries ADD CONSTRAINT purchase_enquiries_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE SET NULL;
ALTER TABLE purchase_enquiries ADD CONSTRAINT purchase_enquiries_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
ALTER TABLE purchase_return_lines ADD CONSTRAINT purchase_return_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE purchase_return_lines ADD CONSTRAINT purchase_return_lines_return_id_fkey FOREIGN KEY (return_id) REFERENCES purchase_returns(id) ON DELETE CASCADE;
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE redemptions ADD CONSTRAINT redemptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE redemptions ADD CONSTRAINT redemptions_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE SET NULL;
ALTER TABLE redemptions ADD CONSTRAINT redemptions_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE RESTRICT;
ALTER TABLE sales_return_lines ADD CONSTRAINT sales_return_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE sales_return_lines ADD CONSTRAINT sales_return_lines_return_id_fkey FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_distributor_id_fkey FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT;
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE;
ALTER TABLE translations ADD CONSTRAINT translations_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES app_languages(code) ON DELETE CASCADE;
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_purchase_invoice_id_fkey FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE SET NULL;
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_campaigns ADD CONSTRAINT whatsapp_campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_campaigns ADD CONSTRAINT whatsapp_campaigns_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES whatsapp_campaigns(id) ON DELETE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_created ON public.activity_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON public.activity_logs USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advisory_created ON public.advisories USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiclass_crop ON public.ai_training_classes USING btree (crop);
CREATE INDEX IF NOT EXISTS idx_aisample_class ON public.ai_training_samples USING btree (class_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON public.batches USING btree (expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_product ON public.batches USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_bom_product ON public.bom USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_bom_components ON public.bom_components USING btree (bom_id);
CREATE INDEX IF NOT EXISTS idx_complaint_events ON public.complaint_events USING btree (complaint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_complaints_farmer ON public.complaints USING btree (farmer_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON public.complaints USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_distributor ON public.credit_debit_notes USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.crm_leads USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_created ON public.crop_diagnoses USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_distributor ON public.crop_diagnoses USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_distsale_lines ON public.distributor_sale_lines USING btree (sale_id);
CREATE INDEX IF NOT EXISTS idx_distsale_distributor ON public.distributor_sales USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_distributors_branch ON public.distributors USING btree (branch_id);
CREATE INDEX IF NOT EXISTS idx_distributors_email_lower ON public.distributors USING btree (lower(email));
CREATE INDEX IF NOT EXISTS idx_distributors_name_trgm ON public.distributors USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_farmers_deletion_status ON public.farmers USING btree (deletion_status) WHERE (deletion_status IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_farmers_email_lower ON public.farmers USING btree (lower(email)) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_farmers_name_trgm ON public.farmers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_farmers_phone ON public.farmers USING btree (phone);
CREATE INDEX IF NOT EXISTS idx_fle_date ON public.financial_ledger_entries USING btree (entry_date);
CREATE INDEX IF NOT EXISTS idx_fle_section ON public.financial_ledger_entries USING btree (statement, section);
CREATE INDEX IF NOT EXISTS idx_gst_challans_period ON public.gst_challans USING btree (period);
CREATE INDEX IF NOT EXISTS idx_recon_docs_ctin ON public.gst_recon_docs USING btree (ctin);
CREATE INDEX IF NOT EXISTS idx_recon_docs_import ON public.gst_recon_docs USING btree (import_id);
CREATE INDEX IF NOT EXISTS idx_recon_docs_period ON public.gst_recon_docs USING btree (source, period);
CREATE INDEX IF NOT EXISTS idx_recon_imports_period ON public.gst_recon_imports USING btree (source, period);
CREATE INDEX IF NOT EXISTS idx_gst_returns_period ON public.gst_returns USING btree (period);
CREATE INDEX IF NOT EXISTS idx_invoices_distributor ON public.invoices USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_farmer ON public.loyalty_transactions USING btree (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON public.order_lines USING btree (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_distributor ON public.orders USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_farmer ON public.orders USING btree (farmer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders USING btree (status);
CREATE INDEX IF NOT EXISTS idx_psale_lines ON public.party_sale_lines USING btree (sale_id);
CREATE INDEX IF NOT EXISTS idx_psale_dist ON public.party_sales USING btree (distributor_id);
CREATE INDEX IF NOT EXISTS idx_psale_farmer ON public.party_sales USING btree (farmer_id);
CREATE INDEX IF NOT EXISTS idx_payments_distributor ON public.payments USING btree (distributor_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_rules_product ON public.price_rules USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_prod_consumption ON public.production_consumptions USING btree (production_order_id);
CREATE INDEX IF NOT EXISTS idx_prod_status ON public.production_orders USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_tests ON public.production_qc_tests USING btree (production_order_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products USING btree (category);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON public.products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON public.products USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_target_crops ON public.products USING gin (target_crops);
CREATE INDEX IF NOT EXISTS idx_products_target_diseases ON public.products USING gin (target_diseases);
CREATE INDEX IF NOT EXISTS idx_enquiry_distributor ON public.purchase_enquiries USING btree (distributor_id);
CREATE INDEX IF NOT EXISTS idx_enquiry_status ON public.purchase_enquiries USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pinv_vendor ON public.purchase_invoices USING btree (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_lines ON public.purchase_order_lines USING btree (po_id);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON public.purchase_orders USING btree (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pret_lines ON public.purchase_return_lines USING btree (return_id);
CREATE INDEX IF NOT EXISTS idx_pret_vendor ON public.purchase_returns USING btree (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemption_distributor ON public.redemptions USING btree (distributor_id, settled);
CREATE INDEX IF NOT EXISTS idx_redemption_farmer ON public.redemptions USING btree (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sret_lines ON public.sales_return_lines USING btree (return_id);
CREATE INDEX IF NOT EXISTS idx_sret_dist ON public.sales_returns USING btree (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_product ON public.stock_levels USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON public.stock_levels USING btree (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON public.stock_movements USING btree (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translations_key ON public.translations USING btree (str_key);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON public.user_permissions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_users_branch ON public.users USING btree (branch_id);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON public.users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON public.users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users USING btree (role);
CREATE INDEX IF NOT EXISTS idx_vpay_vendor ON public.vendor_payments USING btree (vendor_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendors_name_trgm ON public.vendors USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_wamsg_campaign ON public.whatsapp_messages USING btree (campaign_id);

-- Sync sequence values to current max (safe on a fresh restore too)
