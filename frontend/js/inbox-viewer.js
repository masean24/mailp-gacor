/**
 * Inbox Viewer - Public page for checking email inbox
 * Features:
 *  - OTP auto-detect with highlighted code chip
 *  - Staggered entry animations on load
 *  - Visual countdown progress bar for auto-refresh
 *  - New email flash indicator on poll updates
 */

const API_BASE = '/api';
const POLL_INTERVAL_MS = 5000;

const elements = {
  emailInput:       document.getElementById('email-input'),
  btnSearch:        document.getElementById('btn-search'),
  btnRefresh:       document.getElementById('btn-refresh'),
  inboxResult:      document.getElementById('inbox-result'),
  resultEmail:      document.getElementById('result-email'),
  resultLoading:    document.getElementById('result-loading'),
  resultList:       document.getElementById('result-list'),
  resultEmpty:      document.getElementById('result-empty'),
  modal:            document.getElementById('email-modal'),
  modalClose:       document.getElementById('modal-close'),
  modalSubject:     document.getElementById('modal-subject'),
  modalFrom:        document.getElementById('modal-from'),
  modalTo:          document.getElementById('modal-to'),
  modalDate:        document.getElementById('modal-date'),
  modalBody:        document.getElementById('modal-body'),
  refreshBarWrap:   document.getElementById('refresh-bar-wrap'),
  refreshBarFill:   document.getElementById('refresh-bar-fill'),
  refreshCountdown: document.getElementById('refresh-countdown'),
};

let currentEmail   = null;
let pollInterval   = null;
let countdownTimer = null;
let countdownSec   = POLL_INTERVAL_MS / 1000;
let knownEmailIds  = new Set();

// ── OTP Detection ────────────────────────────────────────────────────────────
/**
 * Extract the first OTP-like code from text.
 * Matches 4–8 consecutive digits that appear isolated (not part of a longer number).
 */
function extractOtp(text) {
  if (!text) return null;
  // Match 4–8 digit sequences, optionally separated by spaces/dashes (e.g. "123 456" or "12-34-56")
  const match = text.match(/\b(\d[\d\s\-]{2,10}\d)\b/);
  if (!match) return null;
  const raw = match[1].replace(/[\s\-]/g, '');
  if (raw.length >= 4 && raw.length <= 8) return raw;
  return null;
}

function isOtpEmail(subject, preview) {
  const keywords = /otp|kode|code|verif|token|pin|password sementara|one.time/i;
  return keywords.test(subject) || keywords.test(preview) || extractOtp(subject) || extractOtp(preview);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function showResult() {
  elements.inboxResult.classList.remove('hidden');
}

function setLoading(loading) {
  if (loading) {
    elements.resultLoading.classList.remove('hidden');
    elements.resultList.innerHTML = '';
    elements.resultList.style.display = 'none';
    elements.resultEmpty.classList.add('hidden');
  } else {
    elements.resultLoading.classList.add('hidden');
    elements.resultList.style.display = '';
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(dateString) {
  const date = new Date(dateString);
  const now   = new Date();
  const diff  = now - date;
  if (diff < 60000)    return 'Baru saja';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)} menit lalu`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} jam lalu`;
  return date.toLocaleString('id-ID', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ── Countdown Progress Bar ────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  countdownSec = POLL_INTERVAL_MS / 1000;
  elements.refreshBarWrap.classList.remove('hidden');
  updateCountdownUI();

  countdownTimer = setInterval(() => {
    countdownSec = Math.max(0, countdownSec - 1);
    updateCountdownUI();
    if (countdownSec === 0) resetCountdown();
  }, 1000);
}

function resetCountdown() {
  countdownSec = POLL_INTERVAL_MS / 1000;
  updateCountdownUI();
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateCountdownUI() {
  const total  = POLL_INTERVAL_MS / 1000;
  const pct    = (countdownSec / total) * 100;
  const fill   = elements.refreshBarFill;
  const label  = elements.refreshCountdown;

  fill.style.width = `${pct}%`;
  label.textContent = `${countdownSec}s`;

  fill.classList.remove('refresh-bar-fill--warning', 'refresh-bar-fill--urgent');
  if (pct <= 30) {
    fill.classList.add('refresh-bar-fill--urgent');
  } else if (pct <= 60) {
    fill.classList.add('refresh-bar-fill--warning');
  }
}

// ── Render Inbox Items ────────────────────────────────────────────────────────
function buildItemHtml(item, isNew, suppressAnim) {
  const subject = item.subject || '(No Subject)';
  const preview = item.preview || '';
  const otp     = isOtpEmail(subject, preview) ? extractOtp(subject) || extractOtp(preview) : null;
  const otpStr  = otp ? String(otp) : null;

  const animClass  = suppressAnim ? 'no-anim' : '';
  const otpClass   = otpStr ? 'inbox-item--otp' : '';
  const newClass   = isNew ? 'inbox-item--new' : '';

  const otpBadge   = otpStr
    ? `<span class="otp-badge"><span class="otp-badge__dot"></span>OTP</span>`
    : '';

  const otpChip    = otpStr
    ? `<div class="otp-code-chip">${escapeHtml(otpStr)}</div>`
    : '';

  return `
    <li class="inbox-item ${otpClass} ${newClass} ${animClass}" data-id="${item.id}">
      <div class="inbox-item__header">
        <span class="inbox-item__from">${escapeHtml(item.from)}</span>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
          ${otpBadge}
          <span class="inbox-item__time">${formatTime(item.receivedAt)}</span>
        </div>
      </div>
      <div class="inbox-item__subject">${escapeHtml(subject)}</div>
      <div class="inbox-item__preview">${escapeHtml(preview)}</div>
      ${otpChip}
    </li>
  `;
}

function renderEmails(emails, isPollingRefresh) {
  elements.resultEmpty.classList.add('hidden');

  // Determine new arrivals for polling refreshes
  const newIds = isPollingRefresh
    ? new Set(emails.map(e => e.id).filter(id => !knownEmailIds.has(id)))
    : new Set();

  knownEmailIds = new Set(emails.map(e => e.id));

  elements.resultList.innerHTML = emails
    .map(item => buildItemHtml(
      item,
      newIds.has(item.id),
      isPollingRefresh && !newIds.has(item.id) // suppress anim for old items on refresh
    ))
    .join('');
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchInbox(showLoadingState = true) {
  const email = currentEmail;
  if (!email) return;

  const isPollingRefresh = !showLoadingState;

  if (showLoadingState) {
    showResult();
    elements.resultEmail.textContent = email;
    setLoading(true);
  }

  try {
    const res  = await fetch(`${API_BASE}/inbox/${encodeURIComponent(email)}`);
    const data = await res.json();

    if (!data.success) {
      elements.resultList.innerHTML = '';
      elements.resultEmpty.classList.remove('hidden');
      elements.resultEmpty.querySelector('p').textContent = data.error || 'Gagal memuat data.';
      return;
    }

    const emails = data.data?.emails || [];

    if (emails.length === 0) {
      elements.resultList.innerHTML = '';
      elements.resultEmpty.classList.remove('hidden');
      elements.resultEmpty.querySelector('p').textContent = 'Belum ada email masuk.';
      return;
    }

    renderEmails(emails, isPollingRefresh);
  } catch (err) {
    console.error(err);
    elements.resultList.innerHTML = '';
    elements.resultEmpty.classList.remove('hidden');
    elements.resultEmpty.querySelector('p').textContent =
      'Gagal memuat. Periksa koneksi atau coba lagi.';
  } finally {
    setLoading(false);
    if (isPollingRefresh) resetCountdown();
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  startCountdown();
  pollInterval = setInterval(() => fetchInbox(false), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  stopCountdown();
}

// ── Modal ─────────────────────────────────────────────────────────────────────
async function fetchEmailDetail(emailId) {
  try {
    const res  = await fetch(`${API_BASE}/email/${emailId}`);
    const data = await res.json();
    if (data.success) showEmailModal(data.data);
  } catch (error) {
    console.error('Error fetching email:', error);
  }
}

function showEmailModal(email) {
  elements.modalSubject.textContent = email.subject;
  elements.modalFrom.textContent    = email.from;
  elements.modalTo.textContent      = email.to;
  elements.modalDate.textContent    = new Date(email.receivedAt).toLocaleString('id-ID');

  elements.modalBody.innerHTML = '';

  if (email.bodyHtml) {
    const iframe      = document.createElement('iframe');
    iframe.className  = 'email-iframe';
    iframe.sandbox    = 'allow-same-origin';
    iframe.style.width  = '100%';
    iframe.style.border = 'none';
    iframe.style.minHeight = '300px';

    elements.modalBody.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head>
      <base target="_blank">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               padding: 10px; margin: 0; font-size: 14px; line-height: 1.5; color: #333; background: #fff; }
        img  { max-width: 100%; height: auto; }
        a    { color: #0066cc; }
      </style>
    </head><body>${email.bodyHtml}</body></html>`);
    doc.close();

    iframe.onload = () => {
      try {
        const height = iframe.contentDocument.body.scrollHeight;
        iframe.style.height = Math.min(height + 20, 500) + 'px';
      } catch (e) {
        iframe.style.height = '400px';
      }
    };
  } else if (email.bodyText) {
    const pre = document.createElement('pre');
    pre.style.whiteSpace  = 'pre-wrap';
    pre.style.wordWrap    = 'break-word';
    pre.style.fontFamily  = 'inherit';
    pre.style.margin      = '0';
    pre.textContent       = email.bodyText;
    elements.modalBody.appendChild(pre);
  } else {
    elements.modalBody.textContent = '(No content)';
  }

  elements.modal.classList.remove('closing');
  elements.modal.classList.add('active');
}

function hideEmailModal() {
  elements.modal.classList.add('closing');
  setTimeout(() => {
    elements.modal.classList.remove('active', 'closing');
  }, 200);
}

// ── Search ────────────────────────────────────────────────────────────────────
function searchInbox() {
  const email = elements.emailInput.value.trim();
  if (!email) { elements.emailInput.focus(); return; }
  if (!email.includes('@')) {
    alert('Masukkan alamat email yang valid.');
    return;
  }

  knownEmailIds  = new Set();
  currentEmail   = email;
  localStorage.setItem('hubify_email', email);

  elements.btnRefresh.classList.remove('hidden');
  fetchInbox(true);
  startPolling();
}

// ── Event Listeners ───────────────────────────────────────────────────────────
elements.btnSearch.addEventListener('click', searchInbox);
elements.emailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchInbox();
});

elements.btnRefresh.addEventListener('click', () => {
  if (currentEmail) {
    knownEmailIds = new Set();
    fetchInbox(true);
    // restart countdown
    stopCountdown();
    startCountdown();
  }
});

elements.resultList.addEventListener('click', (e) => {
  const item = e.target.closest('.inbox-item');
  if (item) fetchEmailDetail(item.dataset.id);
});

elements.modalClose.addEventListener('click', hideEmailModal);
elements.modal.addEventListener('click', (e) => {
  if (e.target === elements.modal) hideEmailModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideEmailModal();
});

// ── Prefill from localStorage ─────────────────────────────────────────────────
const savedEmail = localStorage.getItem('hubify_email');
if (savedEmail) {
  elements.emailInput.value = savedEmail;
}
