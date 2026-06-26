import { convert } from 'html-to-text';

/**
 * Get plain text from HTML.
 */
function htmlToText(html) {
    if (!html) return '';
    try {
        return convert(html, {
            wordwrap: false,
            selectors: [
                { selector: 'a', options: { ignoreHref: true } },
                { selector: 'img', format: 'skip' },
            ],
        });
    } catch (e) {
        return '';
    }
}

/**
 * Extract code from subject line.
 * Supports both digit codes and alphanumeric codes with dash.
 */
function extractFromSubject(subject) {
    if (!subject || !subject.trim()) return null;

    // Alphanumeric code with dash (e.g. "H21-0Z0 xAI confirmation code")
    const alpha = subject.match(/\b([A-Z0-9]{2,6}[-\u2013][A-Z0-9]{2,6})\b/i);
    if (alpha && alpha[1]) {
        const code = alpha[1];
        if (/[A-Z]/i.test(code) && /[0-9]/.test(code)) return code;
    }

    // Digit code in subject
    const digit = subject.match(/\b(\d{4,8})\b/);
    if (digit && digit[1]) return digit[1];

    return null;
}

/**
 * Extract digit OTP from explicit body text phrases before using loose fallbacks.
 */
function extractExplicitDigitCode(text) {
    if (!text || !text.trim()) return null;

    const explicitPatterns = [
        /verification\s*code(?:\s*for\s*qwen\s*cloud)?\s*(?:is|:)\s*:?\s*(\d{4,8})/i,
        /(?:code|otp|verification\s*code|pin|password)[\s:]*[:\s]*(\d{4,8})/i,
        /(?:is|:)\s*(\d{4,8})\s*(?:\.|$|\s)/i,
        /(\d{4,8})\s*(?:is your|is the)\s*(?:code|otp|pin)/i,
    ];

    for (const re of explicitPatterns) {
        const m = text.match(re);
        if (m && m[1]) return m[1];
    }

    return null;
}

/**
 * Qwen Cloud sends the code as a large styled HTML block. Keep this narrow so
 * generic HTML emails still use the normal extraction rules.
 */
function extractQwenCloudHtmlCode(html) {
    if (!html || !/qwen\s*cloud/i.test(html)) return null;

    const m = html.match(
        /verification\s*code(?:\s*for\s*qwen\s*cloud)?\s*is:?[\s\S]{0,800}?<div\b[^>]*>\s*(\d{4,8})\s*<\/div>/i
    );

    return m?.[1] || null;
}

/**
 * Loose numeric fallback after explicit phrases have failed.
 */
function extractFallbackDigitCode(text) {
    if (!text || !text.trim()) return null;

    const sixDigit = text.match(/\b(\d{6})\b/);
    if (sixDigit) return sixDigit[1];
    const fiveDigit = text.match(/\b(\d{5})\b/);
    if (fiveDigit) return fiveDigit[1];
    const eightDigit = text.match(/\b(\d{8})\b/);
    if (eightDigit) return eightDigit[1];
    const fourDigit = text.match(/\b(\d{4})\b/);
    if (fourDigit) return fourDigit[1];

    return null;
}

/**
 * Extract OTP from email subject, body text, and/or body HTML.
 * Checks subject first since some services put the code there.
 * Body extraction is digit-only to avoid false positives.
 * Returns first likely OTP string or null.
 */
export function extractOtp(bodyText, bodyHtml, subject) {
    if (subject) {
        const fromSubject = extractFromSubject(subject);
        if (fromSubject) return fromSubject;
    }

    const bodyCandidates = [];
    const text = bodyText || '';
    const htmlText = bodyHtml ? htmlToText(bodyHtml) : '';

    if (text.trim()) bodyCandidates.push(text);
    if (htmlText.trim() && htmlText !== text) bodyCandidates.push(htmlText);

    for (const candidate of bodyCandidates) {
        const explicit = extractExplicitDigitCode(candidate);
        if (explicit) return explicit;
    }

    const qwenHtmlCode = extractQwenCloudHtmlCode(bodyHtml);
    if (qwenHtmlCode) return qwenHtmlCode;

    for (const candidate of bodyCandidates) {
        const fallback = extractFallbackDigitCode(candidate);
        if (fallback) return fallback;
    }

    return null;
}

export default {
    extractOtp,
    htmlToText,
};
