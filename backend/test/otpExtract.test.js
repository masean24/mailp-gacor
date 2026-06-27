/**
 * Unit tests for OTP extraction.
 * Run with: npm test   (uses Node's built-in test runner, no extra deps)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOtp } from '../src/services/otpExtract.js';

test('extracts explicit 6-digit code from body text', () => {
    assert.equal(
        extractOtp('Your verification code is 847291. Do not share.', '', 'Verify'),
        '847291'
    );
});

test('extracts code from subject when present', () => {
    assert.equal(
        extractOtp('', '', 'Your code is 123456'),
        '123456'
    );
});

test('extracts alphanumeric dash code from subject (xAI style)', () => {
    assert.equal(
        extractOtp('', '', 'H21-0Z0 xAI confirmation code'),
        'H21-0Z0'
    );
});

test('extracts Qwen Cloud styled HTML code', () => {
    const html =
        'Your verification code for Qwen Cloud is:' +
        '<table><tr><td><div style="font-size:32px">582013</div></td></tr></table>';
    assert.equal(extractOtp('', html, 'Qwen Cloud verification'), '582013');
});

test('falls back to standalone 6-digit number in body', () => {
    assert.equal(
        extractOtp('Hello, here is 998877 for you', '', 'Notification'),
        '998877'
    );
});

test('extracts code from HTML body when no text body', () => {
    assert.equal(
        extractOtp('', '<p>Your code: <b>445566</b></p>', 'Code'),
        '445566'
    );
});

test('returns null when no code present', () => {
    assert.equal(
        extractOtp('Welcome to our service! Thanks for joining.', '', 'Welcome'),
        null
    );
});

test('handles empty / missing inputs gracefully', () => {
    assert.equal(extractOtp('', '', ''), null);
    assert.equal(extractOtp(null, null, null), null);
    assert.equal(extractOtp(undefined, undefined, undefined), null);
});

test('explicit phrase wins over unrelated digits', () => {
    // The year 2026 should not be picked over the explicit code.
    assert.equal(
        extractOtp('Copyright 2026. Your OTP is 654321.', '', 'Account'),
        '654321'
    );
});
