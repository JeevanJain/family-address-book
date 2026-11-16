import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseEmail, isValidEmail, normalisePhone, isValidPin, validateNewPassword,
  validateNewUser, validateAddress, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} from '../../functions/_lib/validate.js';

const GOOD = {
  first_name: 'Test', surname: 'User', address_line1: '1 Example Road', address_line2: '',
  landmark: '', city: 'Exampleville', state: 'Karnataka', pin: '560001', phone: '9876543210',
  email: 'test@example.com', group_name: 'Family', notes: '',
};

describe('email', () => {
  test('normaliseEmail trims and lower-cases', () => {
    assert.equal(normaliseEmail('  Test@Example.COM '), 'test@example.com');
    assert.equal(normaliseEmail(undefined), '');
    assert.equal(normaliseEmail(42), '');
  });
  test('isValidEmail accepts normal addresses', () => {
    for (const e of ['test@example.com', 'a.b+c@sub.example.co.in', ' test@example.com ']) assert.equal(isValidEmail(e), true, e);
  });
  test('isValidEmail rejects bad addresses', () => {
    for (const e of ['', 'test', 'test@', '@example.com', 'test@example', 'te st@example.com', 'a@@b.com', 'a@b..com', 'a@.com', null, 5]) {
      assert.equal(isValidEmail(e), false, String(e));
    }
    assert.equal(isValidEmail(`${'a'.repeat(250)}@example.com`), false);
  });
});

describe('phone', () => {
  test('plain 10 digits', () => assert.equal(normalisePhone('9876543210'), '9876543210'));
  test('+91 prefix, with and without spaces/dashes', () => {
    assert.equal(normalisePhone('+919876543210'), '9876543210');
    assert.equal(normalisePhone('+91 98765 43210'), '9876543210');
    assert.equal(normalisePhone('+91-98765-43210'), '9876543210');
  });
  test('leading 0', () => {
    assert.equal(normalisePhone('09876543210'), '9876543210');
    assert.equal(normalisePhone('0 98765 43210'), '9876543210');
  });
  test('spaces, dots and brackets', () => {
    assert.equal(normalisePhone(' 98765 43210 '), '9876543210');
    assert.equal(normalisePhone('(98765) 43210'), '9876543210');
  });
  test('rejects wrong length / letters / non-strings', () => {
    for (const p of ['', '12345', '987654321', '98765432100', '98765abcde', '+91 12345', '+9198765432101', null, undefined, 9876543210]) {
      assert.equal(normalisePhone(p), null, String(p));
    }
  });
});

describe('pin', () => {
  test('exactly 6 digits', () => {
    assert.equal(isValidPin('560001'), true);
    for (const p of ['56000', '5600011', 'abcdef', '56 001', '', ' 560001', 560001, null]) assert.equal(isValidPin(p), false, String(p));
  });
});

describe('password', () => {
  test('length limits', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(validateNewPassword('1234567').ok, false);
    assert.equal(validateNewPassword('12345678').ok, true);
    assert.equal(validateNewPassword('x'.repeat(MAX_PASSWORD_LENGTH)).ok, true);
    assert.equal(validateNewPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)).ok, false);
    assert.equal(validateNewPassword(undefined).ok, false);
    assert.equal(validateNewPassword(12345678).ok, false);
  });
  test('error text present on failure', () => {
    assert.match(validateNewPassword('short').error, /at least 8/);
  });
});

describe('validateNewUser', () => {
  test('ok: trims name, lower-cases email', () => {
    const r = validateNewUser({ name: '  Test User ', email: 'Test@Example.com' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { name: 'Test User', email: 'test@example.com' });
  });
  test('missing name / bad email / long name', () => {
    assert.ok(validateNewUser({ name: ' ', email: 'test@example.com' }).errors.name);
    assert.ok(validateNewUser({ name: 'Test', email: 'nope' }).errors.email);
    assert.ok(validateNewUser({ name: 'x'.repeat(101), email: 'test@example.com' }).errors.name);
    assert.equal(validateNewUser(null).ok, false);
    assert.equal(validateNewUser({}).ok, false);
  });
});

describe('validateAddress', () => {
  test('valid address passes, optional empties become null', () => {
    const r = validateAddress(GOOD);
    assert.equal(r.ok, true);
    assert.equal(r.value.address_line2, null);
    assert.equal(r.value.landmark, null);
    assert.equal(r.value.notes, null);
    assert.equal(r.value.phone, '9876543210');
    assert.equal(r.value.email, 'test@example.com');
  });
  for (const f of ['first_name', 'address_line1', 'city', 'state', 'pin', 'phone']) {
    test(`required field ${f}: missing, empty and whitespace-only all fail`, () => {
      for (const bad of [undefined, '', '   ']) {
        const input = { ...GOOD, [f]: bad };
        if (bad === undefined) delete input[f];
        const r = validateAddress(input);
        assert.equal(r.ok, false, `${f}=${JSON.stringify(bad)}`);
        assert.ok(r.errors[f], `error for ${f}`);
      }
    });
  }
  test('surname, line2, landmark, email, group, notes are optional', () => {
    const minimal = { first_name: 'Test', address_line1: '1 Example Road', city: 'X', state: 'Y', pin: '560001', phone: '9876543210' };
    const r = validateAddress(minimal);
    assert.equal(r.ok, true);
    assert.equal(r.value.surname, null);
    assert.equal(r.value.email, null);
    assert.equal(r.value.group_name, null);
  });
  test('bad PIN formats', () => {
    for (const pin of ['56001', '5600011', 'ABCDEF', '56 0001']) assert.ok(validateAddress({ ...GOOD, pin }).errors.pin, pin);
  });
  test('phone normalised on save', () => {
    assert.equal(validateAddress({ ...GOOD, phone: '+91 98765 43210' }).value.phone, '9876543210');
    assert.equal(validateAddress({ ...GOOD, phone: '09876543210' }).value.phone, '9876543210');
    assert.ok(validateAddress({ ...GOOD, phone: '12345' }).errors.phone);
  });
  test('email optional but validated, lower-cased', () => {
    assert.equal(validateAddress({ ...GOOD, email: '' }).value.email, null);
    assert.equal(validateAddress({ ...GOOD, email: '  ' }).value.email, null);
    assert.equal(validateAddress({ ...GOOD, email: 'Test@Example.com' }).value.email, 'test@example.com');
    assert.ok(validateAddress({ ...GOOD, email: 'not-an-email' }).errors.email);
  });
  test('length limits', () => {
    assert.ok(validateAddress({ ...GOOD, first_name: 'x'.repeat(101) }).errors.first_name);
    assert.ok(validateAddress({ ...GOOD, address_line1: 'x'.repeat(201) }).errors.address_line1);
    assert.ok(validateAddress({ ...GOOD, group_name: 'x'.repeat(51) }).errors.group_name);
    assert.ok(validateAddress({ ...GOOD, notes: 'x'.repeat(1001) }).errors.notes);
    assert.equal(validateAddress({ ...GOOD, notes: 'x'.repeat(1000) }).ok, true);
  });
  test('non-string values rejected', () => {
    assert.ok(validateAddress({ ...GOOD, first_name: 5 }).errors.first_name);
    assert.ok(validateAddress({ ...GOOD, city: {} }).errors.city);
    assert.ok(validateAddress({ ...GOOD, pin: 560001 }).errors.pin);
  });
  test('trims text and ignores unknown keys', () => {
    const r = validateAddress({ ...GOOD, first_name: '  Test  ', confirm_duplicate: true, id: 9, created_by: 1 });
    assert.equal(r.value.first_name, 'Test');
    assert.equal('confirm_duplicate' in r.value, false);
    assert.equal('id' in r.value, false);
    assert.equal('created_by' in r.value, false);
  });
  test('null / non-object input does not throw', () => {
    assert.equal(validateAddress(null).ok, false);
    assert.equal(validateAddress(undefined).ok, false);
    assert.equal(validateAddress('x').ok, false);
  });
});
