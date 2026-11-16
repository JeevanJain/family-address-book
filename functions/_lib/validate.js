// Pure validation/normalisation helpers. No I/O, no Cloudflare APIs.

/** Minimum length of a user-chosen password. */
export const MIN_PASSWORD_LENGTH = 8;
/** Maximum password length accepted (bounds PBKDF2 input). */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Trim and lower-case an email. Returns '' for non-strings.
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Basic email syntax check (one @, non-empty local part, dotted domain, no spaces, <= 254 chars).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

/**
 * Normalise an Indian phone number: remove spaces, dashes, dots and brackets,
 * strip a leading "+91" or a leading "0", then require exactly 10 digits.
 * @param {unknown} value
 * @returns {string|null} the 10 digits, or null if invalid
 */
export function normalisePhone(value) {
  if (typeof value !== 'string') return null;
  let v = value.replace(/[\s\-.()]/g, '');
  if (v.startsWith('+91')) v = v.slice(3);
  else if (v.startsWith('0')) v = v.slice(1);
  return /^\d{10}$/.test(v) ? v : null;
}

/**
 * PIN code check: a string of exactly 6 digits.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPin(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

/**
 * Validate a new password chosen by a user (8..200 characters).
 * @param {unknown} value
 * @returns {{ok: boolean, error?: string}}
 */
export function validateNewPassword(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Password is required.' };
  if (value.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (value.length > MAX_PASSWORD_LENGTH) return { ok: false, error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  return { ok: true };
}

/**
 * Validate the body of "create user": { name, email }.
 * @param {object} input
 * @returns {{ok: boolean, value?: {name: string, email: string}, errors: Object<string,string>}}
 */
export function validateNewUser(input) {
  const errors = {};
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'Name is required.';
  else if (name.length > 100) errors.name = 'Name is too long (max 100).';
  if (!isValidEmail(input?.email)) errors.email = 'A valid email is required.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, email: normaliseEmail(input.email) }, errors };
}

// field -> [required, maxLength]
const ADDRESS_TEXT_FIELDS = {
  first_name: [true, 100],
  surname: [false, 100],
  address_line1: [true, 200],
  address_line2: [false, 200],
  landmark: [false, 200],
  city: [true, 100],
  state: [true, 100],
  group_name: [false, 50],
  notes: [false, 1000],
};

const LABELS = {
  first_name: 'First name', surname: 'Surname', address_line1: 'Address line 1',
  address_line2: 'Address line 2', landmark: 'Landmark', city: 'City', state: 'State',
  group_name: 'Group', notes: 'Notes',
};

/**
 * Validate and normalise an address payload (create or full update).
 * Unknown keys (e.g. confirm_duplicate) are ignored. All values must be strings.
 * Text is trimmed; empty optional fields become null; phone is normalised to
 * 10 digits; email is lower-cased.
 * @param {object} input
 * @returns {{ok: boolean,
 *   value: null | {first_name: string, surname: ?string, address_line1: string,
 *     address_line2: ?string, landmark: ?string, city: string, state: string,
 *     pin: string, phone: string, email: ?string, group_name: ?string, notes: ?string},
 *   errors: Object<string,string>}} `errors` maps field name to message
 */
export function validateAddress(input) {
  const errors = {};
  const value = {};
  const src = input && typeof input === 'object' ? input : {};

  for (const [field, [required, max]] of Object.entries(ADDRESS_TEXT_FIELDS)) {
    const raw = src[field];
    if (raw === undefined || raw === null) {
      if (required) errors[field] = `${LABELS[field]} is required.`;
      value[field] = null;
      continue;
    }
    if (typeof raw !== 'string') { errors[field] = `${LABELS[field]} must be text.`; continue; }
    const v = raw.trim();
    if (!v) {
      if (required) errors[field] = `${LABELS[field]} is required.`;
      value[field] = null;
    } else if (v.length > max) {
      errors[field] = `${LABELS[field]} is too long (max ${max}).`;
    } else {
      value[field] = v;
    }
  }

  const pin = typeof src.pin === 'string' ? src.pin.trim() : '';
  if (!isValidPin(pin)) errors.pin = 'PIN must be exactly 6 digits.';
  else value.pin = pin;

  const phone = normalisePhone(src.phone);
  if (phone === null) errors.phone = 'Phone must be 10 digits (a leading +91 or 0 is removed).';
  else value.phone = phone;

  const rawEmail = src.email;
  if (rawEmail === undefined || rawEmail === null || (typeof rawEmail === 'string' && !rawEmail.trim())) {
    value.email = null;
  } else if (!isValidEmail(rawEmail)) {
    errors.email = 'Email is not valid.';
  } else {
    value.email = normaliseEmail(rawEmail);
  }

  if (Object.keys(errors).length) return { ok: false, value: null, errors };
  return { ok: true, value, errors };
}
