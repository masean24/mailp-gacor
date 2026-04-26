/**
 * Inbox Viewer
 * Features: history dropdown, copy OTP 1-click, search/filter, browser notifications
 */

const API_BASE = '/api';
const POLL_INTERVAL_MS = 5000;
const HISTORY_KEY = 'hubify_history';
const HISTORY_MAX = 10;

const el = {
  emailInput:       document.getElementById('email-input'),
  btnSearch:        document.getElementById('btn-search'),
  btnRefresh:       document.getElementById('btn-refresh'),
  inboxResult:      document.getElementById('inbox-result'),
  resultEmail:      document.getElementById('result-email'),
  resultLoading:    document.getElementById('result-loading'),
  resultList:       document.getElementById('result-list'),
  resultEmpty:      document.getElementById('result-empty'),
  inboxSearch:      document.getElementById('inbox-search'),
  historyDropdown:  document.getElementById('history-dropdown'),
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
  toastContainer:   document.getElementById('toast-container'),
};

let currentEmail   = null;
let pollInterval   = null;
let countdownTimer = null;
let countdownSec   = POLL_INTERVAL_MS / 1000;
let knownEmailIds  = new Set();
let lastEmails     = [];
let searchQuery    = '';
let searchTimeout  = null;

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' toast--' + type : ''}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── History ───────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveHistory(email) {
  let h = loadHistory().filter(x => x.email !== email);
  h.unshift({ email, lastChecked: Date.now() });
  if (h.length > HISTORY_MAX) h = h.slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
}

function removeHistoryItem(email) {
  const h = loadHistory().filter(x => x.email !== email);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
  renderHistoryDropdown();
}

function renderHistoryDropdown() {
  const dropdown = el.historyDropdown;
  if (!dropdown) return;
  const query = el.emailInput.value.trim().toLowerCase();
  const all = loadHistory();
  const filtered = query ? all.filter(h => h.email.toLowerCase().includes(query)) : all;

  if (!filtered.length) { dropdown.classList.add('hidden'); return; }

  dropdown.innerHTML = filtered.map(h => `
    <div class="history-item" data-email="${escapeHtml(h.email)}">
      <span class="history-item__email">${escapeHtml(h.email)}</span>
      <button class="history-item__remove" data-remove="${escapeHtml(h.email)}" title="Hapus dari riwayat">✕</button>
    </div>`).join('');
  dropdown.classList.remove('hidden');
}

function hideHistoryDropdown() {
  setTimeout(() => el.historyDropdown?.classList.add('hidden'), 150);
}

// ── Notifications ─────────────────────────────────────────────────────────────
async function requestNotifPermission() {
  try {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    showToast('🔔 Aktifkan notifikasi agar tahu kalau ada email baru masuk meskipun tab di-minimize');
    // Langsung request tanpa delay — delay akan memutus user gesture context di mobile
    const result = await Notification.requestPermission();
    if (result === 'granted') showToast('Notifikasi aktif ✓', 'success');
  } catch (e) {
    // Silent fail: iOS Safari lama dan beberapa mobile browser tidak support
    console.warn('Notifikasi tidak didukung di browser ini:', e);
  }
}

function sendNewEmailNotif(email) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    new Notification('📧 Email baru masuk!', {
      body: `${email.from}: ${email.subject || '(no subject)'}`,
      icon: '/favicon.ico',
      tag: `inbox-${email.id}`,
    });
  } catch (e) {}
}

// ── OTP Detection ─────────────────────────────────────────────────────────────
function extractOtp(text) {
  if (!text) return null;
  const match = text.match(/\b(\d[\d\s\-]{2,10}\d)\b/);
  if (!match) return null;
  const raw = match[1].replace(/[\s\-]/g, '');
  return (raw.length >= 4 && raw.length <= 8) ? raw : null;
}

function isOtpEmail(subject, preview) {
  const kw = /otp|kode|code|verif|token|pin|password sementara|one.time/i;
  return kw.test(subject) || kw.test(preview) || extractOtp(subject) || extractOtp(preview);
}

// ── Copy OTP ──────────────────────────────────────────────────────────────────
async function copyOtp(text, chipEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), {
      value: text, style: 'position:fixed;opacity:0'
    });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (chipEl) {
    const orig = chipEl.textContent;
    chipEl.classList.add('otp-code-chip--copied');
    chipEl.textContent = '✓ COPIED';
    setTimeout(() => { chipEl.classList.remove('otp-code-chip--copied'); chipEl.textContent = orig; }, 2000);
  }
  showToast('OTP disalin! ✓', 'success');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(t) {
  if (!t) return '';
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function formatTime(ds) {
  const d = new Date(ds), diff = Date.now() - d;
  if (diff < 60000)    return 'Baru saja';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)} menit lalu`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} jam lalu`;
  return d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  countdownSec = POLL_INTERVAL_MS / 1000;
  el.refreshBarWrap.classList.remove('hidden');
  updateCountdownUI();
  countdownTimer = setInterval(() => {
    countdownSec = Math.max(0, countdownSec - 1);
    updateCountdownUI();
    if (countdownSec === 0) resetCountdown();
  }, 1000);
}

function resetCountdown() { countdownSec = POLL_INTERVAL_MS / 1000; updateCountdownUI(); }
function stopCountdown()  { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

function updateCountdownUI() {
  const pct = (countdownSec / (POLL_INTERVAL_MS / 1000)) * 100;
  el.refreshBarFill.style.width = `${pct}%`;
  el.refreshCountdown.textContent = `${countdownSec}s`;
  el.refreshBarFill.classList.remove('refresh-bar-fill--warning', 'refresh-bar-fill--urgent');
  if (pct <= 30) el.refreshBarFill.classList.add('refresh-bar-fill--urgent');
  else if (pct <= 60) el.refreshBarFill.classList.add('refresh-bar-fill--warning');
}

// ── Render ────────────────────────────────────────────────────────────────────
function buildItem(item, isNew, noAnim) {
  const subject = item.subject || '(No Subject)';
  const preview = item.preview || '';
  const otpStr  = isOtpEmail(subject, preview) ? (extractOtp(subject) || extractOtp(preview)) : null;
  const cls     = ['inbox-item', otpStr ? 'inbox-item--otp' : '', isNew ? 'inbox-item--new' : '', noAnim ? 'no-anim' : ''].join(' ');
  const badge   = otpStr ? `<span class="otp-badge"><span class="otp-badge__dot"></span>OTP</span>` : '';
  const chip    = otpStr ? `<div class="otp-code-chip" title="Klik untuk salin OTP">${escapeHtml(otpStr)}</div>` : '';
  return `
    <li class="${cls}" data-id="${item.id}">
      <div class="inbox-item__header">
        <span class="inbox-item__from">${escapeHtml(item.from)}</span>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">${badge}<span class="inbox-item__time">${formatTime(item.receivedAt)}</span></div>
      </div>
      <div class="inbox-item__subject">${escapeHtml(subject)}</div>
      <div class="inbox-item__preview">${escapeHtml(preview)}</div>
      ${chip}
    </li>`;
}

function renderEmails(emails, isRefresh) {
  lastEmails = emails;
  const newIds = isRefresh ? new Set(emails.map(e => e.id).filter(id => !knownEmailIds.has(id))) : new Set();
  if (isRefresh) newIds.forEach(id => { const e = emails.find(x => x.id === id); if (e) sendNewEmailNotif(e); });
  knownEmailIds = new Set(emails.map(e => e.id));

  const q = searchQuery.toLowerCase();
  const filtered = q
    ? emails.filter(e => (e.subject||'').toLowerCase().includes(q) || (e.from||'').toLowerCase().includes(q) || (e.preview||'').toLowerCase().includes(q))
    : emails;

  el.resultEmpty.classList.add('hidden');
  if (!filtered.length) {
    el.resultList.innerHTML = '';
    el.resultEmpty.classList.remove('hidden');
    el.resultEmpty.querySelector('p').textContent = q ? `Tidak ada email yang cocok dengan "${searchQuery}".` : 'Belum ada email masuk.';
    return;
  }
  el.resultList.innerHTML = filtered.map(item => buildItem(item, newIds.has(item.id), isRefresh && !newIds.has(item.id))).join('');
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchInbox(showLoad = true) {
  if (!currentEmail) return;
  if (showLoad) {
    el.inboxResult.classList.remove('hidden');
    el.resultEmail.textContent = currentEmail;
    el.resultLoading.classList.remove('hidden');
    el.resultList.innerHTML = '';
    el.resultList.style.display = 'none';
    el.resultEmpty.classList.add('hidden');
  }
  try {
    const res  = await fetch(`${API_BASE}/inbox/${encodeURIComponent(currentEmail)}`);
    const data = await res.json();
    if (!data.success) {
      el.resultEmpty.classList.remove('hidden');
      el.resultEmpty.querySelector('p').textContent = data.error || 'Gagal memuat data.';
      return;
    }
    const emails = data.data?.emails || [];
    if (!emails.length) {
      lastEmails = [];
      el.resultList.innerHTML = '';
      el.resultEmpty.classList.remove('hidden');
      el.resultEmpty.querySelector('p').textContent = 'Belum ada email masuk.';
      return;
    }
    renderEmails(emails, !showLoad);
  } catch {
    el.resultEmpty.classList.remove('hidden');
    el.resultEmpty.querySelector('p').textContent = 'Gagal memuat. Periksa koneksi atau coba lagi.';
  } finally {
    el.resultLoading.classList.add('hidden');
    el.resultList.style.display = '';
    if (!showLoad) resetCountdown();
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() { stopPolling(); startCountdown(); pollInterval = setInterval(() => fetchInbox(false), POLL_INTERVAL_MS); }
function stopPolling()  { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } stopCountdown(); }

// ── Modal ─────────────────────────────────────────────────────────────────────
async function fetchEmailDetail(id) {
  try {
    const data = await fetch(`${API_BASE}/email/${id}`).then(r => r.json());
    if (data.success) showEmailModal(data.data);
  } catch(e) { console.error(e); }
}

function showEmailModal(email) {
  el.modalSubject.textContent = email.subject;
  el.modalFrom.textContent    = email.from;
  el.modalTo.textContent      = email.to;
  el.modalDate.textContent    = new Date(email.receivedAt).toLocaleString('id-ID');
  el.modalBody.innerHTML = '';
  if (email.bodyHtml) {
    const iframe = document.createElement('iframe');
    Object.assign(iframe, { className: 'email-iframe', sandbox: 'allow-same-origin' });
    Object.assign(iframe.style, { width: '100%', border: 'none', minHeight: '300px' });
    el.modalBody.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><base target="_blank"><style>body{font-family:system-ui;padding:10px;margin:0;font-size:14px;line-height:1.5;color:#333;background:#fff}img{max-width:100%}a{color:#0066cc}</style></head><body>${email.bodyHtml}</body></html>`);
    doc.close();
    iframe.onload = () => { try { iframe.style.height = Math.min(iframe.contentDocument.body.scrollHeight + 20, 500) + 'px'; } catch { iframe.style.height = '400px'; } };
  } else if (email.bodyText) {
    const pre = document.createElement('pre');
    Object.assign(pre.style, { whiteSpace: 'pre-wrap', wordWrap: 'break-word', fontFamily: 'inherit', margin: '0' });
    pre.textContent = email.bodyText;
    el.modalBody.appendChild(pre);
  } else {
    el.modalBody.textContent = '(No content)';
  }
  el.modal.classList.remove('closing');
  el.modal.classList.add('active');
}

function hideEmailModal() {
  el.modal.classList.add('closing');
  setTimeout(() => el.modal.classList.remove('active', 'closing'), 200);
}

// ── Search Inbox ──────────────────────────────────────────────────────────────
async function searchInbox() {
  const email = el.emailInput.value.trim();
  if (!email) { el.emailInput.focus(); return; }
  if (!email.includes('@')) { alert('Masukkan alamat email yang valid.'); return; }

  knownEmailIds = new Set();
  currentEmail  = email;
  searchQuery   = '';
  if (el.inboxSearch) el.inboxSearch.value = '';

  saveHistory(email);
  hideHistoryDropdown();

  // Fire-and-forget: jangan await — biar tidak block fetchInbox di mobile
  requestNotifPermission().catch(() => {});

  el.btnRefresh.classList.remove('hidden');
  fetchInbox(true);
  startPolling();
}

// ── Events ────────────────────────────────────────────────────────────────────
el.btnSearch.addEventListener('click', searchInbox);
el.emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchInbox(); });
el.emailInput.addEventListener('focus', () => renderHistoryDropdown());
el.emailInput.addEventListener('blur',  hideHistoryDropdown);
el.emailInput.addEventListener('input', renderHistoryDropdown);

el.historyDropdown?.addEventListener('click', e => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) { e.stopPropagation(); removeHistoryItem(removeBtn.dataset.remove); return; }
  const item = e.target.closest('.history-item');
  if (item) { el.emailInput.value = item.dataset.email; hideHistoryDropdown(); searchInbox(); }
});

el.btnRefresh.addEventListener('click', () => {
  if (!currentEmail) return;
  knownEmailIds = new Set();
  fetchInbox(true);
  stopCountdown();
  startCountdown();
});

el.resultList.addEventListener('click', e => {
  const chip = e.target.closest('.otp-code-chip');
  if (chip) { e.stopPropagation(); copyOtp(chip.textContent.trim(), chip); return; }
  const item = e.target.closest('.inbox-item');
  if (item) fetchEmailDetail(item.dataset.id);
});

el.inboxSearch?.addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => { searchQuery = e.target.value.trim(); renderEmails(lastEmails, false); }, 200);
});

el.modalClose.addEventListener('click', hideEmailModal);
el.modal.addEventListener('click', e => { if (e.target === el.modal) hideEmailModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideEmailModal(); });

// ── Init ──────────────────────────────────────────────────────────────────────
try {
  const savedEmail = localStorage.getItem('hubify_email');
  if (savedEmail) el.emailInput.value = savedEmail;
} catch (e) {}
