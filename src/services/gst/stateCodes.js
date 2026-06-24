// GST state/UT codes (the first two digits of every GSTIN) and GSTIN utilities.
// Source: CBIC GST State Code list. Used to derive Place of Supply, decide
// intra- vs inter-state supply, and validate GSTINs across the compliance suite.

export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

// Reverse map (lower-cased, stripped) for name -> code lookup.
const NAME_TO_CODE = (() => {
  const m = {};
  for (const [code, name] of Object.entries(GST_STATE_CODES)) {
    m[name.toLowerCase().replace(/[^a-z]/g, '')] = code;
  }
  // Common aliases.
  m['andhrapradesh'] = '37';
  m['orissa'] = '21';
  m['pondicherry'] = '34';
  m['nctofdelhi'] = '07';
  return m;
})();

/** First two digits of a GSTIN → state code (or null). */
export function stateCodeFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

/** Resolve a free-text state name to its two-digit GST code (or null). */
export function stateCodeFromName(name) {
  if (!name) return null;
  return NAME_TO_CODE[String(name).toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/** Resolve the supplier (company) state code from its GSTIN, falling back to a name. */
export function resolveStateCode({ gstin, stateName } = {}) {
  return stateCodeFromGstin(gstin) ?? stateCodeFromName(stateName);
}

export function stateName(code) {
  return GST_STATE_CODES[code] ?? null;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Compute the 15th GSTIN check character from the first 14 (CBIC mod-36 with a
 * factor that alternates 1,2). Returns the expected check character.
 */
export function gstinCheckDigit(first14) {
  let factor = 2;
  let sum = 0;
  const mod = ALNUM.length; // 36
  for (let i = first14.length - 1; i >= 0; i -= 1) {
    const code = ALNUM.indexOf(first14[i]);
    if (code < 0) return null;
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / mod) + (addend % mod);
    sum += addend;
  }
  const checkCode = (mod - (sum % mod)) % mod;
  return ALNUM[checkCode];
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Validate a GSTIN: structural regex, a recognised state code, and the mod-36
 * checksum. Returns { valid, reason, stateCode, stateName, pan }.
 */
export function validateGstin(raw) {
  const gstin = String(raw || '').trim().toUpperCase();
  if (!gstin) return { valid: false, reason: 'Empty GSTIN' };
  if (gstin.length !== 15) return { valid: false, reason: 'GSTIN must be 15 characters' };
  if (!GSTIN_RE.test(gstin)) return { valid: false, reason: 'Invalid GSTIN format' };
  const sc = gstin.slice(0, 2);
  if (!GST_STATE_CODES[sc]) return { valid: false, reason: `Unknown state code "${sc}"` };
  const expected = gstinCheckDigit(gstin.slice(0, 14));
  if (expected !== gstin[14]) return { valid: false, reason: 'Checksum digit mismatch' };
  return {
    valid: true,
    reason: 'Valid GSTIN',
    stateCode: sc,
    stateName: GST_STATE_CODES[sc],
    pan: gstin.slice(2, 12),
  };
}
