/* docs/site/assets/app.js - shared script for all docs pages */

// Page list (edit here to change sidebar)
const pages = [
  { id: 'index', title: 'Home', url: 'index.html' },
  { id: 'part-1-idea', title: 'Part 1: The Idea', url: 'part-1-idea.html' },
  { id: 'part-2-system-design', title: 'Part 2: System Design', url: 'part-2-system-design.html' },
  { id: 'part-3-build-strategy', title: 'Part 3: Build Strategy', url: 'part-3-build-strategy.html' },
  { id: 'part-4a-important-code', title: 'Part 4a: Important Code', url: 'part-4a-important-code.html' },
  { id: 'part-4b-tenant-plugin', title: 'Part 4b: Tenant Plugin', url: 'part-4b-tenant-plugin.html' },
  { id: 'part-4c-permissions', title: 'Part 4c: Permissions', url: 'part-4c-permissions.html' },
  { id: 'part-4d-login-service', title: 'Part 4d: Login Service', url: 'part-4d-login-service.html' },
  { id: 'part-4e-refresh-service', title: 'Part 4e: Refresh Service', url: 'part-4e-refresh-service.html' },
  { id: 'part-4f-invite-service', title: 'Part 4f: Invite Service', url: 'part-4f-invite-service.html' },
  { id: 'part-4g-change-role', title: 'Part 4g: Change Role', url: 'part-4g-change-role.html' },
  { id: 'part-4h-plan-limit', title: 'Part 4h: Plan Limit', url: 'part-4h-plan-limit.html' },
  { id: 'part-4i-stripe-webhook', title: 'Part 4i: Stripe Webhook', url: 'part-4i-stripe-webhook.html' },
  { id: 'part-4j-tests-summary', title: 'Part 4j: Test Summary', url: 'part-4j-tests-summary.html' },
  { id: 'part-5-request-flows', title: 'Part 5: Request Flows', url: 'part-5-request-flows.html' },
  { id: 'part-6-how-it-breaks', title: 'Part 6: How It Breaks', url: 'part-6-how-it-breaks.html' },
  { id: 'part-7-testing', title: 'Part 7: Testing Strategy', url: 'part-7-testing.html' },
  { id: 'part-8-interview-prep', title: 'Part 8: Interview Prep', url: 'part-8-interview-prep.html' },
  { id: 'part-9-glossary', title: 'Part 9: Glossary', url: 'part-9-glossary.html' },
];

// Progress tracking (localStorage)
const progressKey = 'multi-tenant-walkthrough-progress';
let progress = {};
try {
  progress = JSON.parse(localStorage.getItem(progressKey)) || {};
} catch (e) { progress = {}; }

const currentPageId = window.location.pathname.split('/').pop().replace('.html','');

// Build sidebar
function buildSidebar() {
  const sidebarMenu = document.getElementById('sidebar-menu');
  if (!sidebarMenu) return;

  pages.forEach(page => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = page.title;
    a.href = page.url;
    a.className = page.id === currentPageId ? 'active' : '';
    li.appendChild(a);
    sidebarMenu.appendChild(li);
  });
}

// Theme toggle
function initTheme() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  toggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
  });
}

// Reading progress bar
function initProgressBar() {
  const bar = document.getElementById('progress-bar');
  if (!bar) return;
  window.addEventListener('scroll', () => {
    const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
    const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    bar.style.width = height > 0 ? (winScroll / height * 100) + '%' : '0%';
  });
}

// Copy button
function initCopyButtons() {
  document.querySelectorAll('.copy-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('.code-block-header').nextElementSibling || btn.parentElement.nextElementSibling;
      const code = pre ? pre.querySelector('code') : null;
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });
  });
}

// Search index (built from pages)
const searchIndex = [
  { title: 'The Idea', part: 'Part 1', text: 'multi-tenant SaaS backend with RBAC isolation', url: 'part-1-idea.html' },
  { title: 'System Design', part: 'Part 2', text: 'shared database tenantId vs schema-per-tenant vs database-per-tenant', url: 'part-2-system-design.html' },
  { title: 'Build Strategy', part: 'Part 3', text: 'step by step build order foundation signup login refresh protect tenant plugin', url: 'part-3-build-strategy.html' },
  { title: 'tenantContext', part: 'Part 4a', text: 'AsyncLocalStorage runWithTenant getTenantId runUnscoped tenant context', url: 'part-4a-important-code.html' },
  { title: 'protect middleware', part: 'Part 4a', text: 'JWT verification tenant context attachment', url: 'part-4a-important-code.html' },
  { title: 'tenantPlugin', part: 'Part 4b', text: 'Mongoose plugin tenant filtering hooks aggregate bulkWrite estimatedDocumentCount', url: 'part-4b-tenant-plugin.html' },
  { title: 'Permissions', part: 'Part 4c', text: 'permission constants requirePermission middleware startup validation', url: 'part-4c-permissions.html' },
  { title: 'Login Service', part: 'Part 4d', text: 'companySlug dummy bcrypt compare generic error message', url: 'part-4d-login-service.html' },
  { title: 'Refresh Service', part: 'Part 4e', text: 'refresh token rotation reuse detection session wipe', url: 'part-4e-refresh-service.html' },
  { title: 'Invite Service', part: 'Part 4f', text: 'hashed invite token atomic claim privilege rule', url: 'part-4f-invite-service.html' },
  { title: 'Change Role', part: 'Part 4g', text: 'self rule last-admin rule privilege escalation deactivation', url: 'part-4g-change-role.html' },
  { title: 'Plan Limit', part: 'Part 4h', text: 'race-safe atomic counter project slot reservation', url: 'part-4h-plan-limit.html' },
  { title: 'Stripe Webhook', part: 'Part 4i', text: 'PLANNED raw body signature check Redis claim StripeEvent idempotency', url: 'part-4i-stripe-webhook.html' },
  { title: 'Request Flows', part: 'Part 5', text: 'viewer deletes project IDOR Stripe duplicate event scenarios', url: 'part-5-request-flows.html' },
  { title: 'How It Breaks', part: 'Part 6', text: 'isolation gaps 15-minute token window known limitations', url: 'part-6-how-it-breaks.html' },
  { title: 'Testing', part: 'Part 7', text: 'test files concurrency coverage untested behaviors', url: 'part-7-testing.html' },
  { title: 'Interview Prep', part: 'Part 8', text: 'pitch 2-minute 30-second hardest questions trade-offs', url: 'part-8-interview-prep.html' },
  { title: 'Glossary', part: 'Part 9', text: 'technical terms plain definitions AsyncLocalStorage JWT RBAC', url: 'part-9-glossary.html' },
];

function initSearch() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  if (!searchInput || !searchResults) return;

  let timeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(timeout);
    const query = e.target.value.toLowerCase().trim();
    if (!query) { searchResults.classList.remove('active'); return; }
    timeout = setTimeout(() => {
      const results = searchIndex.filter(item =>
        item.title.toLowerCase().includes(query) ||
        item.text.toLowerCase().includes(query) ||
        item.part.toLowerCase().includes(query)
      ).slice(0, 10);
      renderSearchResults(results, searchResults);
    }, 100);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    if (e.key === 'Enter') { e.preventDefault(); selectHighlighted(); }
    if (e.key === 'Escape') { searchResults.classList.remove('active'); }
  });

  let selectedIndex = -1;
  function moveSelection(dir) {
    const items = searchResults.querySelectorAll('.search-result-item');
    if (items.length === 0) return;
    selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + dir));
    items.forEach((item, i) => item.classList.toggle('selected', i === selectedIndex));
    if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
  function selectHighlighted() {
    const item = searchResults.querySelector('.search-result-item.selected');
    if (item) window.location.href = item.dataset.url;
  }

  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.remove('active');
    }
  });
  window.addEventListener('/', () => searchInput.focus());
}

function renderSearchResults(results, container) {
  container.innerHTML = '';
  if (results.length === 0) {
    container.innerHTML = '<div class="search-result-item" style="color:var(--color-text);opacity:0.6">No results</div>';
    container.classList.add('active');
    return;
  }
  results.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'search-result-item' + (i === 0 ? ' selected' : '');
    div.dataset.url = item.url;
    div.innerHTML = `<div class="result-title">${escapeHtml(item.title)}</div><div class="result-meta">${escapeHtml(item.part)}</div>`;
    div.addEventListener('click', () => window.location.href = item.url);
    container.appendChild(div);
  });
  container.classList.add('active');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Previous / Next navigation
function initPrevNext() {
  const currentIndex = pages.findIndex(p => p.id === currentPageId);
  if (currentIndex === -1) return;
  const prevLink = document.getElementById('prev-link');
  const nextLink = document.getElementById('next-link');
  if (prevLink && pages[currentIndex - 1]) {
    prevLink.href = pages[currentIndex - 1].url;
    prevLink.textContent = 'Previous: ' + pages[currentIndex - 1].title;
  } else if (prevLink) {
    prevLink.style.display = 'none';
  }
  if (nextLink && pages[currentIndex + 1]) {
    nextLink.href = pages[currentIndex + 1].url;
    nextLink.textContent = 'Next: ' + pages[currentIndex + 1].title;
  } else if (nextLink) {
    nextLink.style.display = 'none';
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  buildSidebar();
  initTheme();
  initProgressBar();
  initCopyButtons();
  initSearch();
  initPrevNext();
});
