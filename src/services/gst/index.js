// GST API / GSP adapter — LIVE, DB-driven (no mock). Credentials are configured
// from the Company Settings page (company_settings.gst_api_*) and used to make
// real authenticated HTTP calls to the configured GSP/IRP for e-invoice (IRN),
// e-way bill and return filing. When not configured + enabled, every operation
// throws a clear, actionable error so nothing is silently faked.

import { query } from '../../db/index.js';

const TIMEOUT_MS = Number(process.env.GST_API_TIMEOUT_MS || 20000);

function notConfigured() {
  const err = new Error('GST API is not configured. Add your GSP/IRP credentials in Company → GST API and enable it.');
  err.statusCode = 400;
  return err;
}

/** Load the GST API config (+ company GSTIN) from the singleton company row. */
export async function loadGstConfig() {
  const { rows } = await query(
    `SELECT gstin, gst_api_provider, gst_api_base_url, gst_api_client_id, gst_api_username,
            gst_api_key, gst_api_secret, gst_api_password, gst_api_enabled
     FROM company_settings WHERE id = 1`,
  );
  const r = rows[0] || {};
  return {
    gstin: r.gstin || null,
    provider: r.gst_api_provider || null,
    baseUrl: (r.gst_api_base_url || '').replace(/\/$/, ''),
    clientId: r.gst_api_client_id || null,
    username: r.gst_api_username || null,
    apiKey: r.gst_api_key || null,
    apiSecret: r.gst_api_secret || null,
    password: r.gst_api_password || null,
    enabled: !!r.gst_api_enabled,
    configured: !!(r.gst_api_enabled && r.gst_api_base_url && r.gst_api_key),
  };
}

export async function getGstProviderName() {
  const c = await loadGstConfig();
  return c.configured ? (c.provider || 'gsp') : 'not configured';
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.apiKey) h['x-api-key'] = cfg.apiKey;
  if (cfg.apiSecret) h['x-api-secret'] = cfg.apiSecret;
  if (cfg.clientId) h['x-client-id'] = cfg.clientId;
  if (cfg.username) h['x-gstin-username'] = cfg.username;
  if (cfg.password) h['x-gstin-password'] = cfg.password;
  if (cfg.gstin) h['x-gstin'] = cfg.gstin;
  return h;
}

/** Authenticated POST to the GSP, with timeout + flexible error surfacing. */
async function gspPost(cfg, path, body) {
  if (!cfg.configured) throw notConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    const err = new Error(`GST API request failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    err.statusCode = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json.message || json.error || json.errorMessage || text || `HTTP ${res.status}`;
    const err = new Error(`GST API error: ${msg}`);
    err.statusCode = res.status >= 500 ? 502 : 400;
    throw err;
  }
  // GSPs nest the result under data/result/Data; unwrap if present.
  return json.data || json.result || json.Data || json;
}

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };

// ── Provider: each method loads config + calls the configured GSP ──
export const gstProvider = {
  get name() { return 'gsp'; },

  async generateIRN(ctxData) {
    const cfg = await loadGstConfig();
    const out = await gspPost(cfg, '/einvoice/generate', { gstin: cfg.gstin, invoice: ctxData.invoice, lines: ctxData.lines, buyer: ctxData.distributor, seller: ctxData.company });
    return {
      irn: pick(out, 'irn', 'Irn'),
      ackNo: String(pick(out, 'ackNo', 'AckNo') ?? ''),
      ackDate: pick(out, 'ackDate', 'AckDt') || new Date().toISOString(),
      signedQr: pick(out, 'signedQr', 'signedQRCode', 'SignedQRCode'),
      signedInvoice: pick(out, 'signedInvoice', 'SignedInvoice'),
      provider: cfg.provider || 'gsp',
    };
  },

  async cancelIRN({ invoiceId, reason }) {
    const cfg = await loadGstConfig();
    await gspPost(cfg, '/einvoice/cancel', { gstin: cfg.gstin, invoiceId, reason });
    return { cancelled: true, provider: cfg.provider || 'gsp' };
  },

  async generateEWB({ invoice, distanceKm }) {
    const cfg = await loadGstConfig();
    const out = await gspPost(cfg, '/ewaybill/generate', { gstin: cfg.gstin, invoice, distanceKm });
    return {
      ewbNo: String(pick(out, 'ewbNo', 'EwbNo', 'ewayBillNo') ?? ''),
      ewbDate: pick(out, 'ewbDate', 'EwbDt') || new Date().toISOString(),
      validUntil: pick(out, 'validUntil', 'validUpto', 'ValidUpto'),
      provider: cfg.provider || 'gsp',
    };
  },

  async cancelEWB({ invoiceId, reason }) {
    const cfg = await loadGstConfig();
    await gspPost(cfg, '/ewaybill/cancel', { gstin: cfg.gstin, invoiceId, reason });
    return { cancelled: true, provider: cfg.provider || 'gsp' };
  },

  /** File a return (GSTR-1 / GSTR-3B) through the GSP; returns the portal ARN. */
  async fileReturn({ returnType, period, gstin, payload }) {
    const cfg = await loadGstConfig();
    const out = await gspPost(cfg, `/returns/${String(returnType).toLowerCase()}/file`, { gstin: gstin || cfg.gstin, fp: period, data: payload });
    const arn = pick(out, 'arn', 'Arn', 'referenceId', 'ref_id');
    if (!arn) { const e = new Error('GSP did not return an ARN'); e.statusCode = 502; throw e; }
    return { arn: String(arn), status: 'FILED', provider: cfg.provider || 'gsp', filedAt: new Date().toISOString() };
  },

  async fetchReturn({ returnType, period, gstin }) {
    const cfg = await loadGstConfig();
    const out = await gspPost(cfg, `/returns/${String(returnType).toLowerCase()}/get`, { gstin: gstin || cfg.gstin, fp: period });
    return { provider: cfg.provider || 'gsp', data: out };
  },
};

/** Probe connectivity/auth against the configured GSP (used by "Test connection"). */
export async function testGstApiConnection() {
  const cfg = await loadGstConfig();
  if (!cfg.baseUrl) return { ok: false, message: 'No base URL set. Enter your GSP/IRP base URL.' };
  if (!cfg.apiKey) return { ok: false, message: 'No API key set.' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/health`, { method: 'GET', headers: authHeaders(cfg), signal: ctrl.signal });
    if (res.ok) return { ok: true, message: `Connected to ${cfg.provider || 'GSP'} (${res.status}).` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Reached ${cfg.baseUrl} but auth was rejected (${res.status}). Check credentials.` };
    return { ok: true, message: `Reached ${cfg.baseUrl} (${res.status}). Endpoint up; verify the /health path for your GSP.` };
  } catch (e) {
    return { ok: false, message: `Could not reach ${cfg.baseUrl}: ${e.name === 'AbortError' ? 'timed out' : e.message}` };
  } finally {
    clearTimeout(t);
  }
}
