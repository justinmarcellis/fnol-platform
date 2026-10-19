import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDateTime, formatDate, formatTime, formatRelative, formatEnum, humanize, formatMoney, formatNumber,
  formatPercent, formatDuration, formatPolicyNumber, formatClaimNumber, initials, baseLocale,
} from '../../../../src/web/shared/format.js';
import { setLocale } from '../../../../src/web/shared/i18n.js';

const AT = '2026-10-19T12:24:54.227Z';
const UTC = { timeZone: 'UTC' };

test('humanized dates in en and es', () => {
  assert.equal(formatDateTime(AT, { ...UTC, locale: 'en' }), 'Oct 19, 2026, 12:24 PM');
  assert.equal(formatDateTime(AT, { ...UTC, locale: 'es' }), '19 oct 2026, 12:24');
  assert.equal(formatDate(AT, { ...UTC, locale: 'en' }), 'Oct 19, 2026');
  assert.equal(formatTime(AT, { ...UTC, locale: 'en' }), '12:24 PM');
  assert.equal(formatDateTime(new Date(AT), { ...UTC, locale: 'en-US' }), 'Oct 19, 2026, 12:24 PM');
  assert.equal(formatDateTime('not a date'), 'not a date');
  assert.equal(formatDateTime(null), '—');
  assert.doesNotMatch(formatDateTime(AT, { ...UTC, locale: 'en' }), /[  ]/);
});

test('relative time', () => {
  const now = Date.parse(AT);
  const at = (min) => new Date(now + min * 60000).toISOString();
  assert.equal(formatRelative(at(120), { now, locale: 'en' }), 'in 2 h');
  assert.equal(formatRelative(at(-3), { now, locale: 'en' }), '3 min ago');
  assert.equal(formatRelative(at(-0.2), { now, locale: 'en' }), 'just now');
  assert.equal(formatRelative(at(-59.9), { now, locale: 'en' }), '1 h ago');
  assert.equal(formatRelative(at(-3 * 1440), { now, locale: 'en' }), '3 d ago');
  assert.equal(formatRelative(at(-3), { now, locale: 'es' }), 'hace 3 min');
  assert.equal(formatRelative(at(120), { now, locale: 'es' }), 'en 2 h');
  assert.equal(formatRelative(at(-30 * 1440), { now, locale: 'en', ...UTC }), 'Sep 19, 2026');
  assert.equal(formatRelative(undefined), '—');
});

test('enum labels', () => {
  assert.equal(formatEnum('pending_info', { locale: 'en' }), 'Pending info');
  assert.equal(formatEnum('commercial_auto', { locale: 'en' }), 'Commercial auto');
  assert.equal(formatEnum('pending_info', { locale: 'es' }), 'Información pendiente');
  assert.equal(formatEnum('commercial_auto', { locale: 'es' }), 'Auto comercial');
  assert.equal(formatEnum('auto_collision'), 'Auto collision');
  assert.equal(formatEnum('fraudDisclosure'), 'Fraud disclosure');
  assert.equal(humanize('ACORD_mapping-v2'), 'ACORD mapping v2');
  assert.equal(formatEnum(''), '—');
  setLocale('es');
  assert.equal(formatEnum('closed'), 'Cerrado', 'follows the active i18n locale');
  setLocale('en');
  assert.equal(formatEnum('closed'), 'Closed');
});

test('money and numbers', () => {
  assert.equal(formatMoney(12480, { locale: 'en' }), '$12,480');
  assert.equal(formatMoney(640, { locale: 'en' }), '$640.00');
  assert.equal(formatMoney({ amount: 500, currency: 'USD' }, { locale: 'en' }), '$500.00');
  assert.equal(formatMoney({ amount: 1234.5, currency: 'EUR' }, { locale: 'es' }), '1234,50 €');
  assert.equal(formatMoney(86500, { locale: 'en', compact: true }), '$86.5K');
  assert.equal(formatMoney(12480.4, { locale: 'en', cents: false }), '$12,480');
  assert.equal(formatMoney('x'), '—');
  assert.equal(formatNumber(12480, { locale: 'en' }), '12,480');
  assert.equal(formatNumber(12480, { locale: 'es' }), '12.480');
  assert.equal(formatPercent(0.31, { locale: 'en' }), '31%');
  assert.equal(formatPercent(0.31, { locale: 'es' }), '31 %');
  assert.equal(formatDuration(18), '18 min');
  assert.equal(formatDuration(125), '2 h 5 min');
  assert.equal(formatDuration(3 * 1440 + 240), '3 d 4 h');
});

test('policy and claim numbers', () => {
  assert.equal(formatPolicyNumber(' pa mi 2241587 '), 'PA-MI-2241587');
  assert.equal(formatPolicyNumber('PAMI2241587'), 'PA-MI-2241587');
  assert.equal(formatPolicyNumber('aut-1000_42'), 'AUT-1000-42');
  assert.equal(formatPolicyNumber('PA-MI-2241587', { mask: true }), 'PA-MI-•••1587');
  assert.equal(formatPolicyNumber(''), '—');
  assert.equal(formatClaimNumber('kpt-2026-15'), 'KPT-2026-000015');
  assert.equal(formatClaimNumber('KPT-2026-000015'), 'KPT-2026-000015');
  assert.equal(formatClaimNumber('AUR2026000142'), 'AUR-2026-000142');
  assert.equal(formatClaimNumber('ext/77'), 'EXT-77');
  assert.equal(formatClaimNumber(null), '—');
});

test('initials and locale helpers', () => {
  assert.equal(initials('Dana Whitfield'), 'DW');
  assert.equal(initials('Northwind Mutual (fictional)'), 'NM');
  assert.equal(initials('Corbin & Vale'), 'CV');
  assert.equal(initials('csr'), 'CS');
  assert.equal(initials(''), '?');
  assert.equal(baseLocale('es-MX'), 'es');
  assert.equal(baseLocale('fr'), 'en');
});
