/**
 * Hubify Store - Unified Frontend JavaScript
 * Combines Temporary Email Generator and OTP Finder into a single-page app logic.
 */

// API Base URL
const API_BASE = '/api';
const POLL_INTERVAL_MS = 5000;
const HISTORY_KEY = 'hubify_history';
const HISTORY_MAX = 10;

// State Variables
const state = {
  activeTab: 'generator', // 'generator' | 'otp'
  theme: 'dark', // 'dark' | 'light'
  
  // Generator State
  gen: {
    email: null,
    expiresAt: null,
    domains: [],
    pollInterval: null,
    lastRefreshTime: null,
    refreshCounterInterval: null,
    lastEmailCount: 0,
    notificationEnabled: localStorage.getItem('hubify_notification') !== 'false',
  },

  // OTP Finder State
  otp: {
    email: null,
    emails: [],
    pollInterval: null,
    countdownTimer: null,
    countdownSec: POLL_INTERVAL_MS / 1000,
    knownEmailIds: new Set(),
    searchQuery: '',
    searchTimeout: null,
  },

  // Protected inbox access tokens intentionally live only in memory. They are
  // never persisted in localStorage or included in a URL.
  inboxAccessTokens: new Map(),
  unlock: {
    address: null,
    onSuccess: null,
  },

  // Audio Context for Notifications
  audioContext: null,
};

// DOM Elements
const el = {
  // Theme and Tabs
  body: document.body,
  themeToggle: document.getElementById('theme-toggle-btn'),
  tabGenerator: document.getElementById('tab-generator-btn'),
  tabOtp: document.getElementById('tab-otp-btn'),
  panelGenerator: document.getElementById('panel-generator'),
  panelOtp: document.getElementById('panel-otp'),
  toastContainer: document.getElementById('toast-container'),

  // Shared Modal
  modal: document.getElementById('email-modal'),
  modalClose: document.getElementById('modal-close'),
  modalSubject: document.getElementById('modal-subject'),
  modalFrom: document.getElementById('modal-from'),
  modalTo: document.getElementById('modal-to'),
  modalDate: document.getElementById('modal-date'),
  modalBody: document.getElementById('modal-body'),
  unlockModal: document.getElementById('inbox-unlock-modal'),
  unlockClose: document.getElementById('inbox-unlock-close'),
  unlockAddress: document.getElementById('inbox-unlock-address'),
  unlockForm: document.getElementById('inbox-unlock-form'),
  unlockPassword: document.getElementById('inbox-unlock-password'),

  // Generator Tab Elements
  genEmailDisplay: document.getElementById('gen-email-display'),
  genBtnCopy: document.getElementById('gen-btn-copy'),
  genGenderSelect: document.getElementById('gen-gender-select'),
  genBtnRefresh: document.getElementById('gen-btn-refresh'),
  genBtnNew: document.getElementById('gen-btn-new'),
  genBtnDelete: document.getElementById('gen-btn-delete'),
  genCustomForm: document.getElementById('gen-custom-form'),
  genCustomLocal: document.getElementById('gen-custom-local'),
  genCustomDomain: document.getElementById('gen-custom-domain'),
  genCustomProtect: document.getElementById('gen-custom-protect'),
  genCustomPassword: document.getElementById('gen-custom-password'),
  genTtlText: document.getElementById('gen-ttl-text'),
  genStatusDot: document.getElementById('gen-status-dot'),
  genBtnNotification: document.getElementById('gen-btn-notification'),
  genInboxEmpty: document.getElementById('gen-inbox-empty'),
  genEmailList: document.getElementById('gen-email-list'),

  // OTP Finder Tab Elements
  otpEmailInput: document.getElementById('otp-email-input'),
  otpHistoryDropdown: document.getElementById('otp-history-dropdown'),
  otpBtnSearch: document.getElementById('otp-btn-search'),
  otpBtnRefresh: document.getElementById('otp-btn-refresh'),
  otpResultContainer: document.getElementById('otp-result-container'),
  otpResultEmail: document.getElementById('otp-result-email'),
  otpInboxSearch: document.getElementById('otp-inbox-search'),
  otpResultLoading: document.getElementById('otp-result-loading'),
  otpResultList: document.getElementById('otp-result-list'),
  otpResultEmpty: document.getElementById('otp-result-empty'),
  otpRefreshBarWrap: document.getElementById('otp-refresh-bar-wrap'),
  otpRefreshBarFill: document.getElementById('otp-refresh-bar-fill'),
  otpRefreshCountdown: document.getElementById('otp-refresh-countdown'),
};

function inboxHeaders(address, headers = {}) {
  const token = state.inboxAccessTokens.get(String(address || '').toLowerCase());
  return token ? { ...headers, 'X-Inbox-Access': token } : headers;
}

function closeUnlockModal() {
  state.unlock.address = null;
  state.unlock.onSuccess = null;
  if (el.unlockModal) el.unlockModal.classList.remove('active');
  if (el.unlockPassword) el.unlockPassword.value = '';
}

function promptInboxUnlock(address, onSuccess) {
  if (!el.unlockModal || !address) return;
  state.unlock.address = address;
  state.unlock.onSuccess = onSuccess;
  if (el.unlockAddress) el.unlockAddress.textContent = address;
  el.unlockModal.classList.add('active');
  window.setTimeout(() => el.unlockPassword?.focus(), 0);
}

async function unlockInbox(address, password) {
  const res = await fetch(`${API_BASE}/inbox/${encodeURIComponent(address)}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Gagal membuka inbox');
  state.inboxAccessTokens.set(address.toLowerCase(), data.data.accessToken);
  return data.data;
}

function handleLockedInbox(res, data, address, onSuccess) {
  if (res.status !== 423 || !data?.requiresPassword) return false;
  stopGenPolling();
  stopOtpPolling();
  promptInboxUnlock(address, onSuccess);
  return true;
}

// ── Audio Notification ────────────────────────────────────────────────────────
function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioContext;
}

function playNotificationSound() {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Pleasant "ding" sound
    oscillator.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
    oscillator.frequency.setValueAtTime(1100, ctx.currentTime + 0.1); // Higher pitch
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.log('Audio not supported or blocked by user interaction policy');
  }
}

// ── Toast Notification ────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  if (!el.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Browser Notifications ─────────────────────────────────────────────────────
async function requestNotifPermission() {
  try {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    const result = await Notification.requestPermission();
    if (result === 'granted') showToast('Notifikasi aktif ✓', 'success');
  } catch (e) {
    console.warn('Notifikasi tidak didukung di browser ini:', e);
  }
}

function sendBrowserNotification(title, body, tag) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: tag || 'hubify-email',
    });
  } catch (e) {}
}

// ── Shared Helpers ───────────────────────────────────────────────────────────
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Baru saja';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} menit lalu`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} jam lalu`;

  return date.toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTTL(expiresAt) {
  if (!expiresAt) return 'Email aktif selama 24 jam';

  const expires = new Date(expiresAt);
  const now = new Date();
  const diff = expires - now;

  if (diff <= 0) return 'Email expired';

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  return `Expires in ${hours}h ${minutes}m`;
}

const BASE_TITLE = 'Hubify Store - Temporary Email';
function updateTitleBadge(count) {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

// ── Tab & Theme Management ────────────────────────────────────────────────────
function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('hubify_theme', theme);
  if (theme === 'light') {
    el.body.classList.add('light-mode');
    if (el.themeToggle) el.themeToggle.innerHTML = '🌙'; // moon icon when light mode active
  } else {
    el.body.classList.remove('light-mode');
    if (el.themeToggle) el.themeToggle.innerHTML = '☀️'; // sun icon when dark mode active
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('hubify_theme') || 'dark';
  setTheme(savedTheme);
}

function switchTab(tabName) {
  state.activeTab = tabName;
  
  if (tabName === 'generator') {
    el.tabGenerator.classList.add('active');
    el.tabOtp.classList.remove('active');
    el.panelGenerator.classList.add('active');
    el.panelOtp.classList.remove('active');
    
    // Stop OTP polling & start generator polling if email exists
    stopOtpPolling();
    if (state.gen.email) {
      startGenPolling();
      // Update title badge with generator counts
      updateTitleBadge(state.gen.lastEmailCount);
    } else {
      updateTitleBadge(0);
    }
  } else {
    el.tabGenerator.classList.remove('active');
    el.tabOtp.classList.add('active');
    el.panelGenerator.classList.remove('active');
    el.panelOtp.classList.add('active');
    
    // Stop Generator polling & start OTP polling if search email exists
    stopGenPolling();
    if (state.otp.email) {
      startOtpPolling();
      // Update title badge with OTP counts
      updateTitleBadge(state.otp.emails.length);
    } else {
      updateTitleBadge(0);
    }
  }
}

// ── Email Detail Modal ────────────────────────────────────────────────────────
async function showEmailDetail(emailId) {
  try {
    const address = state.activeTab === 'otp' ? state.otp.email : state.gen.email;
    const res = await fetch(`${API_BASE}/email/${emailId}`, {
      headers: inboxHeaders(address),
    });
    const data = await res.json();

    if (handleLockedInbox(res, data, address, () => showEmailDetail(emailId))) return;

    if (data.success) {
      const email = data.data;
      el.modalSubject.textContent = email.subject || '(No Subject)';
      el.modalFrom.textContent = email.from;
      el.modalTo.textContent = email.to;
      el.modalDate.textContent = new Date(email.receivedAt).toLocaleString('id-ID');

      el.modalBody.innerHTML = '';

      if (email.bodyHtml) {
        const iframe = document.createElement('iframe');
        iframe.className = 'email-iframe';
        // Email HTML is untrusted. Keep its document in an opaque sandbox so
        // it cannot share this application's origin or access credentials.
        iframe.sandbox = '';
        iframe.style.width = '100%';
        iframe.style.border = 'none';
        iframe.style.minHeight = '300px';

        el.modalBody.appendChild(iframe);

        iframe.srcdoc = `
          <!DOCTYPE html>
          <html>
          <head>
            <base target="_blank">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                padding: 10px;
                margin: 0;
                font-size: 14px;
                line-height: 1.5;
                color: #333333;
                background: #ffffff;
              }
              img { max-width: 100%; height: auto; }
              a { color: #4f46e5; }
            </style>
          </head>
          <body>${email.bodyHtml}</body>
          </html>
        `;
        // A sandboxed srcdoc has an opaque origin, so its height cannot be
        // measured safely from the parent application.
        iframe.style.height = '400px';
      } else if (email.bodyText) {
        const pre = document.createElement('pre');
        pre.className = 'email-text';
        pre.textContent = email.bodyText;
        el.modalBody.appendChild(pre);
      } else {
        el.modalBody.textContent = '(No content)';
      }

      el.modal.classList.add('active');
    } else {
      showToast('Gagal memuat detail email', 'error');
    }
  } catch (error) {
    console.error('Error fetching email details:', error);
    showToast('Gagal memuat detail email', 'error');
  }
}

function hideEmailModal() {
  el.modal.classList.remove('active');
}


// ── TAB 1: Generator Code ─────────────────────────────────────────────────────

function setGenLoading(isLoading) {
  if (el.genStatusDot) {
    if (isLoading) {
      el.genStatusDot.classList.add('loading');
    } else {
      el.genStatusDot.classList.remove('loading');
    }
  }
}

function updateNotificationButton() {
  if (el.genBtnNotification) {
    el.genBtnNotification.textContent = state.gen.notificationEnabled ? '🔔' : '🔕';
    el.genBtnNotification.title = state.gen.notificationEnabled 
      ? 'Notifikasi Aktif (Klik untuk matikan)' 
      : 'Notifikasi Mati (Klik untuk nyalakan)';
  }
}

async function fetchDomains() {
  try {
    const res = await fetch(`${API_BASE}/domains`);
    const data = await res.json();
    if (data.success) {
      state.gen.domains = data.data;
      
      // Populate custom domain select
      if (el.genCustomDomain) {
        el.genCustomDomain.innerHTML = state.gen.domains
          .map((d) => `<option value="${d.id}">${d.domain}</option>`)
          .join('');
      }
    }
  } catch (error) {
    console.error('Error fetching domains:', error);
    showToast('Gagal memuat daftar domain', 'error');
  }
}

async function generateEmail() {
  if (state.gen.domains.length === 0) {
    showToast('Domain tidak tersedia', 'error');
    return;
  }

  try {
    const randomDomain = state.gen.domains[Math.floor(Math.random() * state.gen.domains.length)];
    const domainId = randomDomain.id;
    const gender = el.genGenderSelect?.value || 'random';
    
    const res = await fetch(`${API_BASE}/inbox/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domainId, gender }),
    });
    const data = await res.json();

    if (data.success) {
      setGeneratorEmail(data.data.email, data.data.expiresAt);
      showToast('Email baru dibuat!', 'success');
    } else {
      showToast(data.error || 'Gagal membuat email', 'error');
    }
  } catch (error) {
    console.error('Error generating email:', error);
    showToast('Gagal membuat email', 'error');
  }
}

async function useCustomEmail(localPart, domainId) {
  try {
    const domain = state.gen.domains.find((item) => item.id === domainId);
    const address = domain ? `${localPart}@${domain.domain}` : null;
    const res = await fetch(`${API_BASE}/inbox/custom`, {
      method: 'POST',
      headers: inboxHeaders(address, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ localPart, domainId }),
    });
    const data = await res.json();

    if (data.success) {
      setGeneratorEmail(data.data.email, data.data.expiresAt);
      showToast('Email kustom berhasil dipasang!', 'success');
    } else if (handleLockedInbox(res, data, address, () => useCustomEmail(localPart, domainId))) {
      return;
    } else {
      showToast(data.error || 'Gagal memasang email kustom', 'error');
    }
  } catch (error) {
    console.error('Error setting custom email:', error);
    showToast('Gagal memasang email kustom', 'error');
  }
}

async function reserveCustomEmail(localPart, domainId, password) {
  try {
    const res = await fetch(`${API_BASE}/inbox/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPart, domainId, password }),
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Gagal mereservasi inbox', 'error');
      return;
    }

    state.inboxAccessTokens.set(data.data.email.toLowerCase(), data.data.accessToken);
    setGeneratorEmail(data.data.email, data.data.expiresAt);
    showToast('Inbox berhasil di-reserve dan dikunci!', 'success');
  } catch (error) {
    console.error('Error reserving inbox:', error);
    showToast('Gagal mereservasi inbox', 'error');
  }
}

async function fetchGenInbox() {
  if (!state.gen.email) return;

  setGenLoading(true);
  try {
    const res = await fetch(`${API_BASE}/inbox/${encodeURIComponent(state.gen.email)}`, {
      headers: inboxHeaders(state.gen.email),
    });
    const data = await res.json();

    if (data.success) {
      const emails = data.data.emails;

      // Notify if new emails arrive
      if (state.gen.lastEmailCount > 0 && emails.length > state.gen.lastEmailCount) {
        const newEmail = emails[0];
        if (state.gen.notificationEnabled) {
          playNotificationSound();
          sendBrowserNotification(
            '📧 Email Baru Masuk!',
            `Dari: ${newEmail.from}\nSubjek: ${newEmail.subject || '(tanpa subjek)'}`,
            `gen-${newEmail.id}`
          );
        }
      }
      state.gen.lastEmailCount = emails.length;

      renderGenInbox(emails);
      
      if (data.data.expiresAt) {
        state.gen.expiresAt = data.data.expiresAt;
        if (el.genTtlText) el.genTtlText.textContent = formatTTL(data.data.expiresAt);
      }
      
      state.gen.lastRefreshTime = new Date();
      updateLastRefreshUI();
      
      if (state.activeTab === 'generator') {
        updateTitleBadge(emails.length);
      }
    } else if (handleLockedInbox(res, data, state.gen.email, fetchGenInbox)) {
      return;
    } else {
      showToast(data.error || 'Gagal memuat inbox', 'error');
    }
  } catch (error) {
    console.error('Error loading generator inbox:', error);
  } finally {
    setGenLoading(false);
  }
}

function updateLastRefreshUI() {
  if (!state.gen.lastRefreshTime || !el.genStatusDot) return;
  const statusText = el.genStatusDot.parentNode.querySelector('span');
  if (statusText) {
    const diff = Math.floor((new Date() - state.gen.lastRefreshTime) / 1000);
    let timeStr = 'Never';
    if (diff < 5) timeStr = 'Baru saja';
    else if (diff < 60) timeStr = `${diff}d lalu`;
    else timeStr = `${Math.floor(diff / 60)}m lalu`;
    statusText.textContent = `Last: ${timeStr}`;
  }
}

async function deleteGenInbox() {
  if (!state.gen.email) return;

  try {
    const res = await fetch(`${API_BASE}/inbox/${encodeURIComponent(state.gen.email)}`, {
      method: 'DELETE',
      headers: inboxHeaders(state.gen.email),
    });
    const data = await res.json();

    if (data.success) {
      showToast('Kotak masuk dihapus!', 'success');
      state.gen.email = null;
      localStorage.removeItem('hubify_email');
      generateEmail();
    } else if (handleLockedInbox(res, data, state.gen.email, deleteGenInbox)) {
      return;
    } else {
      showToast(data.error || 'Gagal menghapus kotak masuk', 'error');
    }
  } catch (error) {
    console.error('Error deleting inbox:', error);
    showToast('Gagal menghapus kotak masuk', 'error');
  }
}

function setGeneratorEmail(email, expiresAt) {
  state.gen.email = email;
  state.gen.expiresAt = expiresAt;
  state.gen.lastEmailCount = 0;
  
  if (el.genEmailDisplay) el.genEmailDisplay.value = email;
  if (el.genTtlText) el.genTtlText.textContent = formatTTL(expiresAt);

  localStorage.setItem('hubify_email', email);

  startGenPolling();
  fetchGenInbox();
}

function renderGenInbox(emails) {
  if (!emails || emails.length === 0) {
    el.genInboxEmpty.classList.remove('hidden');
    el.genEmailList.classList.add('hidden');
    return;
  }

  el.genInboxEmpty.classList.add('hidden');
  el.genEmailList.classList.remove('hidden');

  el.genEmailList.innerHTML = emails
    .map((email) => `
      <li class="email-item" data-id="${email.id}">
        <div class="email-item__header">
          <span class="email-item__from">${escapeHtml(email.from)}</span>
          <span class="email-item__time">${formatTime(email.receivedAt)}</span>
        </div>
        <div class="email-item__subject">${escapeHtml(email.subject || '(No Subject)')}</div>
        <div class="email-item__preview">${escapeHtml(email.preview || '')}</div>
      </li>
    `)
    .join('');
}

function startGenPolling() {
  stopGenPolling();
  state.gen.pollInterval = setInterval(fetchGenInbox, POLL_INTERVAL_MS);
  
  if (state.gen.refreshCounterInterval) clearInterval(state.gen.refreshCounterInterval);
  state.gen.refreshCounterInterval = setInterval(updateLastRefreshUI, 1000);
}

function stopGenPolling() {
  if (state.gen.pollInterval) {
    clearInterval(state.gen.pollInterval);
    state.gen.pollInterval = null;
  }
  if (state.gen.refreshCounterInterval) {
    clearInterval(state.gen.refreshCounterInterval);
    state.gen.refreshCounterInterval = null;
  }
}


// ── TAB 2: OTP Finder Code ────────────────────────────────────────────────────

// Load History
function loadSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSearchHistory(email) {
  let history = loadSearchHistory().filter(x => x.email !== email);
  history.unshift({ email, lastChecked: Date.now() });
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
}

function removeHistoryItem(email) {
  const history = loadSearchHistory().filter(x => x.email !== email);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
  renderHistoryDropdown();
}

function renderHistoryDropdown() {
  const dropdown = el.otpHistoryDropdown;
  if (!dropdown) return;
  
  const query = el.otpEmailInput.value.trim().toLowerCase();
  const all = loadSearchHistory();
  const filtered = query ? all.filter(h => h.email.toLowerCase().includes(query)) : all;

  if (!filtered.length) {
    dropdown.classList.add('hidden');
    return;
  }

  dropdown.innerHTML = filtered
    .map(h => `
      <div class="history-item" data-email="${escapeHtml(h.email)}">
        <span class="history-item__email">${escapeHtml(h.email)}</span>
        <button class="history-item__remove" data-remove="${escapeHtml(h.email)}" title="Hapus dari riwayat">✕</button>
      </div>`
    )
    .join('');
  dropdown.classList.remove('hidden');
}

function hideHistoryDropdown() {
  setTimeout(() => el.otpHistoryDropdown?.classList.add('hidden'), 180);
}

// OTP Detection
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

async function copyOtpCode(text, chipEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), {
      value: text,
      style: 'position:fixed;opacity:0'
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
    setTimeout(() => {
      chipEl.classList.remove('otp-code-chip--copied');
      chipEl.textContent = orig;
    }, 2000);
  }
  showToast('OTP disalin! ✓', 'success');
}

// Polling & Countdown
function startOtpCountdown() {
  stopOtpCountdown();
  state.otp.countdownSec = POLL_INTERVAL_MS / 1000;
  el.otpRefreshBarWrap.classList.remove('hidden');
  updateCountdownUI();
  
  state.otp.countdownTimer = setInterval(() => {
    state.otp.countdownSec = Math.max(0, state.otp.countdownSec - 1);
    updateCountdownUI();
    if (state.otp.countdownSec === 0) {
      resetCountdown();
    }
  }, 1000);
}

function resetCountdown() {
  state.otp.countdownSec = POLL_INTERVAL_MS / 1000;
  updateCountdownUI();
}

function stopOtpCountdown() {
  if (state.otp.countdownTimer) {
    clearInterval(state.otp.countdownTimer);
    state.otp.countdownTimer = null;
  }
}

function updateCountdownUI() {
  const total = POLL_INTERVAL_MS / 1000;
  const pct = (state.otp.countdownSec / total) * 100;
  el.otpRefreshBarFill.style.width = `${pct}%`;
  el.otpRefreshCountdown.textContent = `${state.otp.countdownSec}s`;
  
  el.otpRefreshBarFill.classList.remove('warning', 'urgent');
  if (pct <= 30) el.otpRefreshBarFill.classList.add('urgent');
  else if (pct <= 60) el.otpRefreshBarFill.classList.add('warning');
}

// Rendering searched emails
function buildOtpEmailItem(item, isNew, noAnim) {
  const subject = item.subject || '(No Subject)';
  const preview = item.preview || '';
  const otpStr = item.otp || (isOtpEmail(subject, preview) ? (extractOtp(subject) || extractOtp(preview)) : null);
  
  const cls = [
    'email-item',
    otpStr ? 'email-item--otp' : '',
    isNew ? 'email-item--new' : '',
    noAnim ? 'no-anim' : ''
  ].join(' ');

  const badge = otpStr ? `<span class="otp-badge"><span class="otp-badge__dot"></span>OTP</span>` : '';
  const chip = otpStr ? `<div class="otp-code-chip" title="Klik untuk salin OTP">${escapeHtml(otpStr)}</div>` : '';
  
  return `
    <li class="${cls}" data-id="${item.id}">
      <div class="email-item__header">
        <span class="email-item__from">${escapeHtml(item.from)}</span>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
          ${badge}
          <span class="email-item__time">${formatTime(item.receivedAt)}</span>
        </div>
      </div>
      <div class="email-item__subject">${escapeHtml(subject)}</div>
      <div class="email-item__preview">${escapeHtml(preview)}</div>
      ${chip}
    </li>`;
}

function renderOtpEmails(emails, isRefresh) {
  state.otp.emails = emails;
  
  const newIds = isRefresh
    ? new Set(emails.map(e => e.id).filter(id => !state.otp.knownEmailIds.has(id)))
    : new Set();
    
  if (isRefresh) {
    newIds.forEach(id => {
      const e = emails.find(x => x.id === id);
      if (e) {
        // Trigger alert / audio sound
        playNotificationSound();
        sendBrowserNotification(
          '📧 Email Baru Masuk (OTP)!',
          `${e.from}: ${e.subject || '(tanpa subjek)'}`,
          `otp-${e.id}`
        );
      }
    });
  }
  state.otp.knownEmailIds = new Set(emails.map(e => e.id));

  const q = state.otp.searchQuery.toLowerCase();
  const filtered = q
    ? emails.filter(e => 
        (e.subject || '').toLowerCase().includes(q) || 
        (e.from || '').toLowerCase().includes(q) || 
        (e.preview || '').toLowerCase().includes(q) || 
        (e.otp || '').toLowerCase().includes(q)
      )
    : emails;

  el.otpResultEmpty.classList.add('hidden');
  
  if (!filtered.length) {
    el.otpResultList.innerHTML = '';
    el.otpResultEmpty.classList.remove('hidden');
    el.otpResultEmpty.querySelector('p').textContent = q 
      ? `Tidak ada email yang cocok dengan "${state.otp.searchQuery}".` 
      : 'Belum ada email masuk.';
    return;
  }
  
  el.otpResultList.innerHTML = filtered
    .map(item => buildOtpEmailItem(item, newIds.has(item.id), isRefresh && !newIds.has(item.id)))
    .join('');
}

async function fetchOtpInbox(showLoad = true) {
  if (!state.otp.email) return;

  if (showLoad) {
    el.otpResultContainer.classList.remove('hidden');
    el.otpResultEmail.textContent = state.otp.email;
    el.otpResultLoading.classList.remove('hidden');
    el.otpResultList.innerHTML = '';
    el.otpResultList.style.display = 'none';
    el.otpResultEmpty.classList.add('hidden');
  }

  try {
    const res = await fetch(`${API_BASE}/inbox/${encodeURIComponent(state.otp.email)}`, {
      headers: inboxHeaders(state.otp.email),
    });
    const data = await res.json();
    
    if (!data.success) {
      if (handleLockedInbox(res, data, state.otp.email, () => fetchOtpInbox(showLoad))) return;
      el.otpResultEmpty.classList.remove('hidden');
      el.otpResultEmpty.querySelector('p').textContent = data.error || 'Gagal memuat data.';
      return;
    }
    
    const emails = data.data?.emails || [];
    if (!emails.length) {
      state.otp.emails = [];
      el.otpResultList.innerHTML = '';
      el.otpResultEmpty.classList.remove('hidden');
      el.otpResultEmpty.querySelector('p').textContent = 'Belum ada email masuk.';
      return;
    }

    renderOtpEmails(emails, !showLoad);
    
    if (state.activeTab === 'otp') {
      updateTitleBadge(emails.length);
    }
  } catch (error) {
    console.error('Error fetching OTP inbox:', error);
    el.otpResultEmpty.classList.remove('hidden');
    el.otpResultEmpty.querySelector('p').textContent = 'Gagal memuat. Periksa koneksi atau coba lagi.';
  } finally {
    el.otpResultLoading.classList.add('hidden');
    el.otpResultList.style.display = '';
    if (!showLoad) resetCountdown();
  }
}

function startOtpPolling() {
  stopOtpPolling();
  startOtpCountdown();
  state.otp.pollInterval = setInterval(() => fetchOtpInbox(false), POLL_INTERVAL_MS);
}

function stopOtpPolling() {
  if (state.otp.pollInterval) {
    clearInterval(state.otp.pollInterval);
    state.otp.pollInterval = null;
  }
  stopOtpCountdown();
}

async function executeSearchOtp() {
  const email = el.otpEmailInput.value.trim();
  if (!email) {
    el.otpEmailInput.focus();
    return;
  }
  if (!email.includes('@')) {
    showToast('Masukkan alamat email yang valid', 'error');
    return;
  }

  state.otp.knownEmailIds = new Set();
  state.otp.email = email;
  state.otp.searchQuery = '';
  if (el.otpInboxSearch) el.otpInboxSearch.value = '';

  saveSearchHistory(email);
  hideHistoryDropdown();
  requestNotifPermission().catch(() => {});

  el.otpBtnRefresh.classList.remove('hidden');
  fetchOtpInbox(true);
  startOtpPolling();
}


// ── Combined Event Listeners ──────────────────────────────────────────────────

function bindEvents() {
  // Theme Switching
  if (el.themeToggle) {
    el.themeToggle.addEventListener('click', () => {
      const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
      setTheme(nextTheme);
    });
  }

  // Tabs Switching
  if (el.tabGenerator) {
    el.tabGenerator.addEventListener('click', () => switchTab('generator'));
  }
  if (el.tabOtp) {
    el.tabOtp.addEventListener('click', () => switchTab('otp'));
  }

  // Shared Detail Modal Closure
  if (el.modalClose) {
    el.modalClose.addEventListener('click', hideEmailModal);
  }
  if (el.modal) {
    el.modal.addEventListener('click', (e) => {
      if (e.target === el.modal) hideEmailModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideEmailModal();
  });

  if (el.unlockClose) {
    el.unlockClose.addEventListener('click', closeUnlockModal);
  }
  if (el.unlockModal) {
    el.unlockModal.addEventListener('click', (e) => {
      if (e.target === el.unlockModal) closeUnlockModal();
    });
  }
  if (el.unlockForm) {
    el.unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const address = state.unlock.address;
      const password = el.unlockPassword?.value || '';
      if (!address || !password) return;
      try {
        await unlockInbox(address, password);
        const onSuccess = state.unlock.onSuccess;
        closeUnlockModal();
        showToast('Inbox berhasil dibuka', 'success');
        onSuccess?.();
      } catch (error) {
        showToast(error.message || 'Password salah', 'error');
      }
    });
  }

  // Generator Action Bindings
  if (el.genBtnCopy) {
    el.genBtnCopy.addEventListener('click', () => {
      if (state.gen.email) {
        navigator.clipboard.writeText(state.gen.email).then(() => {
          showToast('Email disalin! ✓', 'success');
        }).catch(() => {
          // fallback
          const input = document.createElement('input');
          input.value = state.gen.email;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
          showToast('Email disalin! ✓', 'success');
        });
      }
    });
  }

  if (el.genBtnRefresh) {
    el.genBtnRefresh.addEventListener('click', () => {
      fetchGenInbox();
      showToast('Segarkan!', 'success');
    });
  }

  if (el.genBtnNew) {
    el.genBtnNew.addEventListener('click', generateEmail);
  }

  if (el.genBtnDelete) {
    el.genBtnDelete.addEventListener('click', () => {
      if (confirm('Hapus kotak masuk ini beserta semua pesannya?')) {
        deleteGenInbox();
      }
    });
  }

  if (el.genBtnNotification) {
    el.genBtnNotification.addEventListener('click', () => {
      state.gen.notificationEnabled = !state.gen.notificationEnabled;
      localStorage.setItem('hubify_notification', state.gen.notificationEnabled);
      updateNotificationButton();
      
      if (state.gen.notificationEnabled) {
        requestNotifPermission();
        showToast('Notifikasi diaktifkan!', 'success');
      } else {
        showToast('Notifikasi dimatikan', 'success');
      }
    });
  }

  if (el.genCustomForm) {
    el.genCustomForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const localPart = el.genCustomLocal.value.trim();
      const domainId = el.genCustomDomain.value;
      const isProtected = el.genCustomProtect?.checked;
      const password = el.genCustomPassword?.value || '';

      if (localPart && domainId) {
        if (isProtected) {
          if (password.length < 10) {
            showToast('Password inbox minimal 10 karakter', 'error');
            return;
          }
          reserveCustomEmail(localPart, parseInt(domainId), password);
          el.genCustomPassword.value = '';
        } else {
          useCustomEmail(localPart, parseInt(domainId));
        }
        el.genCustomLocal.value = '';
      }
    });
  }

  if (el.genCustomProtect && el.genCustomPassword) {
    el.genCustomProtect.addEventListener('change', () => {
      el.genCustomPassword.classList.toggle('hidden', !el.genCustomProtect.checked);
      el.genCustomPassword.required = el.genCustomProtect.checked;
      if (!el.genCustomProtect.checked) el.genCustomPassword.value = '';
    });
  }

  if (el.genEmailList) {
    el.genEmailList.addEventListener('click', (e) => {
      const item = e.target.closest('.email-item');
      if (item) {
        showEmailDetail(item.dataset.id);
      }
    });
  }

  // OTP Finder Action Bindings
  if (el.otpBtnSearch) {
    el.otpBtnSearch.addEventListener('click', executeSearchOtp);
  }
  if (el.otpEmailInput) {
    el.otpEmailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') executeSearchOtp();
    });
    el.otpEmailInput.addEventListener('focus', renderHistoryDropdown);
    el.otpEmailInput.addEventListener('blur', hideHistoryDropdown);
    el.otpEmailInput.addEventListener('input', renderHistoryDropdown);
  }

  if (el.otpHistoryDropdown) {
    el.otpHistoryDropdown.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        e.stopPropagation();
        removeHistoryItem(removeBtn.dataset.remove);
        return;
      }
      const item = e.target.closest('.history-item');
      if (item) {
        el.otpEmailInput.value = item.dataset.email;
        hideHistoryDropdown();
        executeSearchOtp();
      }
    });
  }

  if (el.otpBtnRefresh) {
    el.otpBtnRefresh.addEventListener('click', () => {
      if (!state.otp.email) return;
      state.otp.knownEmailIds = new Set();
      fetchOtpInbox(true);
      stopOtpCountdown();
      startOtpCountdown();
    });
  }

  if (el.otpResultList) {
    el.otpResultList.addEventListener('click', (e) => {
      const chip = e.target.closest('.otp-code-chip');
      if (chip) {
        e.stopPropagation();
        copyOtpCode(chip.textContent.trim(), chip);
        return;
      }
      const item = e.target.closest('.email-item');
      if (item) {
        showEmailDetail(item.dataset.id);
      }
    });
  }

  if (el.otpInboxSearch) {
    el.otpInboxSearch.addEventListener('input', (e) => {
      clearTimeout(state.otp.searchTimeout);
      state.otp.searchTimeout = setTimeout(() => {
        state.otp.searchQuery = e.target.value.trim();
        renderOtpEmails(state.otp.emails, false);
      }, 200);
    });
  }
}

// ── App Initialization ────────────────────────────────────────────────────────
function getDirectInboxAddress() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path || path.includes('/')) return null;
  try {
    const address = decodeURIComponent(path).trim().toLowerCase();
    return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address) ? address : null;
  } catch {
    return null;
  }
}

async function init() {
  initTheme();
  bindEvents();
  updateNotificationButton();

  // Load active tab from URL query params
  const urlParams = new URLSearchParams(window.location.search);
  const activeTabParam = urlParams.get('tab');
  
  // Set tab initially based on parameter or default
  if (activeTabParam === 'otp') {
    switchTab('otp');
  } else {
    switchTab('generator');
  }

  // Pre-fill fields
  // 1. Generator - fetch domains, check last saved
  await fetchDomains();
  
  const directInbox = getDirectInboxAddress();
  const savedEmail = localStorage.getItem('hubify_email');
  if (directInbox) {
    const [, domain] = directInbox.split('@');
    const domainExists = state.gen.domains.some((item) => item.domain === domain);
    if (domainExists) {
      setGeneratorEmail(directInbox, null);
    } else {
      showToast('Domain pada link ini belum terhubung atau belum aktif', 'error');
      generateEmail();
    }
  } else if (savedEmail) {
    const [, domain] = savedEmail.split('@');
    const domainExists = state.gen.domains.some((d) => d.domain === domain);
    if (domainExists) {
      setGeneratorEmail(savedEmail, null);
    } else {
      generateEmail();
    }
  } else {
    generateEmail();
  }

  // 2. OTP search pre-fill from localStorage (if any checked)
  const history = loadSearchHistory();
  if (history.length > 0) {
    el.otpEmailInput.value = history[0].email;
  }
}

document.addEventListener('DOMContentLoaded', init);
