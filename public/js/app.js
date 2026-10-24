'use strict';
/* XC Wiki — reader SPA: router, home, article, search, themes, progress. */

/* Storage can be unavailable (private-mode webviews throw on access).
   Every read/write goes through these helpers so a blocked store can
   never kill the page. */
function rawStore() { try { return localStorage; } catch { return null; } }
function rawSessionStore() { try { return sessionStorage; } catch { return null; } }
const store = {
  get(k) { const s = rawStore(); if (!s) return null; try { return s.getItem(k); } catch { return null; } },
  set(k, v) { const s = rawStore(); if (!s) return; try { s.setItem(k, v); } catch { /* unavailable */ } },
  remove(k) { const s = rawStore(); if (!s) return; try { s.removeItem(k); } catch { /* unavailable */ } },
};
const sessionStore = {
  get(k) { const s = rawSessionStore(); if (!s) return null; try { return s.getItem(k); } catch { return null; } },
  set(k, v) { const s = rawSessionStore(); if (!s) return; try { s.setItem(k, v); } catch { /* unavailable */ } },
};

const App = {
  settings: null,
  user: null,
  token: store.get('xcwiki_token') || '',
  previewMode: sessionStore.get('xcwiki_preview') === '1',
  anonKey: null,
};

function anonKey() {
  if (!App.anonKey) {
    App.anonKey = store.get('xcwiki_anon');
    if (!App.anonKey) {
      App.anonKey = 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      store.set('xcwiki_anon', App.anonKey);
    }
  }
  return App.anonKey;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (App.token) headers['Authorization'] = 'Bearer ' + App.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && App.token) {
    App.token = ''; store.remove('xcwiki_token'); App.user = null;
    renderUserArea();
    /* Login wall: an expired session goes back to the sign-in screen. */
    if (!/^#\/(login|customer-login|setup|set-password)/.test(location.hash)) location.hash = '#/customer-login';
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hours ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' day ago';
  return new Date(iso).toLocaleDateString();
}

/* ---------------- theme ---------------- */

function applyTheme() {
  let pref = store.get('xcwiki_theme') || 'system';
  let effective = pref;
  if (pref === 'system') effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', effective);
  document.querySelectorAll('.theme-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.themeSet === pref);
  });
}

function initTheme() {
  if (!store.get('xcwiki_theme') && App.settings) {
    store.set('xcwiki_theme', App.settings.default_theme === 'light' ? 'light' : 'system');
  }
  applyTheme();
  document.querySelectorAll('.theme-toggle button').forEach(b => {
    b.onclick = () => { store.set('xcwiki_theme', b.dataset.themeSet); applyTheme(); };
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
}

/* ---------------- branding ---------------- */

function applyBranding(s) {
  if (!s) return;
  const css =
    `:root,[data-theme="dark"]{--bg:${s.dark_bg || '#0B0E14'};--bg2:${s.dark_bg || '#0B0E14'};--card:${s.dark_surface || '#131826'};--card2:${s.dark_surface || '#131826'};--text:${s.dark_text || '#FFFFFF'};--accent:${s.primary_color || '#2E7CF6'};--accent2:${s.primary_color || '#2E7CF6'};--purple:${s.accent_color || '#7C5CFF'};--input:${s.dark_surface || '#131826'};}` +
    `[data-theme="light"]{--bg:${s.light_bg || '#F4F6FB'};--bg2:${s.light_bg || '#F4F6FB'};--card:${s.light_surface || '#FFFFFF'};--card2:${s.light_surface || '#FFFFFF'};--text:${s.light_text || '#0F172A'};--accent:${s.primary_color || '#2E7CF6'};--accent2:${s.primary_color || '#2E7CF6'};--purple:${s.accent_color || '#7C5CFF'};--input:${s.light_bg || '#F4F6FB'};}`;
  let el = document.getElementById('branding-css');
  if (!el) { el = document.createElement('style'); el.id = 'branding-css'; document.head.appendChild(el); }
  el.textContent = css + '\n' + (s.custom_css || '');
  // logo (size adjustable 32–72px via branding, default 48)
  const mark = document.getElementById('brand-mark');
  const logoH = Math.max(32, Math.min(72, parseInt(s.logo_height, 10) || 48));
  mark.style.width = logoH + 'px';
  mark.style.height = logoH + 'px';
  mark.style.fontSize = Math.round(logoH * 0.34) + 'px';
  if (s.logo_url) {
    mark.innerHTML = `<img src="${esc(s.logo_url)}" alt="" style="width:100%;height:100%;object-fit:contain">`;
  } else {
    mark.textContent = (s.logo_text || s.site_title || 'XC').trim().slice(0, 2).toUpperCase();
  }
  // favicon
  if (s.favicon_url) {
    let fav = document.querySelector('link[rel="icon"]');
    if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
    fav.href = s.favicon_url;
  }
  // footer
  const parts = [];
  if (s.footer_text) parts.push(s.footer_text);
  if (s.copyright_line) parts.push(s.copyright_line);
  if (String(s.powered_by) === '1') parts.push('Powered by XC Wiki');
  const ft = document.getElementById('footer-text');
  if (ft) ft.textContent = parts.join(' · ') || '© XC Wiki';
  // hero + titles
  const bt = document.getElementById('brand-title');
  if (bt) bt.textContent = s.logo_text || s.site_title;
  const bg = document.getElementById('brand-tagline');
  if (bg) bg.textContent = s.site_tagline;
  if (s.site_title) document.title = s.site_title + (s.site_tagline ? ' ' + s.site_tagline : '');
}

/* ---------------- user area / preview ---------------- */

function renderUserArea() {
  const el = document.getElementById('user-area');
  const banner = document.getElementById('preview-banner');
  if (App.user && App.user.kind === 'customer') {
    el.innerHTML = `<button class="user-chip" id="user-chip">👤 ${esc(App.user.name)} ▾</button>`;
    document.getElementById('user-chip').onclick = () => {
      openModal(`
        <div style="padding:20px">
          <h3 style="margin-top:0">${esc(App.user.name)}</h3>
          <p style="color:var(--muted);font-size:.85rem">${esc(App.user.email)}${App.user.group_name ? ' · ' + esc(App.user.group_name) : ''}</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
            <a class="btn" href="#/account">My Account</a>
            <button class="btn ghost" id="m-logout">Sign out</button>
          </div>
        </div>`);
      document.getElementById('m-logout').onclick = async () => {
        await api('/api/customer/logout', { method: 'POST' }).catch(() => {});
        App.token = ''; store.remove('xcwiki_token'); App.user = null;
        closeModal(); renderUserArea(); location.hash = '#/';
      };
    };
    banner.classList.add('hidden');
  } else if (App.user && !App.previewMode) {
    el.innerHTML = `<button class="user-chip" id="user-chip">👤 ${esc(App.user.display_name)} ▾</button>`;
    document.getElementById('user-chip').onclick = () => {
      openModal(`
        <div style="padding:20px">
          <h3 style="margin-top:0">${esc(App.user.display_name)}</h3>
          <p style="color:var(--muted);font-size:.85rem">${esc(App.user.email)} · ${esc(App.user.role)}</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
            <a class="btn" href="#/admin">Staff dashboard</a>
            <button class="btn ghost" id="m-preview">Preview as customer</button>
            <button class="btn ghost" id="m-logout">Sign out</button>
          </div>
        </div>`);
      document.getElementById('m-preview').onclick = () => { closeModal(); setPreviewMode(true); };
      document.getElementById('m-logout').onclick = async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        App.token = ''; store.remove('xcwiki_token'); App.user = null;
        closeModal(); renderUserArea(); location.hash = '#/';
      };
    };
    banner.classList.add('hidden');
  } else if (App.user && App.previewMode) {
    el.innerHTML = `<span class="chip">👁️ Preview Customer</span>`;
    banner.classList.remove('hidden');
  } else {
    el.innerHTML = `<a class="btn ghost small" href="#/customer-login">Customer login</a>`;
    banner.classList.add('hidden');
  }
}

function setPreviewMode(on) {
  App.previewMode = on;
  sessionStore.set('xcwiki_preview', on ? '1' : '0');
  renderUserArea();
  route();
}

async function loadMe() {
  if (!App.token) { App.user = null; return; }
  try {
    const d = await api('/api/me');
    App.user = d.user;
  } catch { App.user = null; }
}

/* ---------------- search modal ---------------- */

let searchTimer = null;

function openSearch(prefill = '') {
  const m = document.getElementById('search-modal');
  const input = document.getElementById('search-input');
  m.classList.remove('hidden');
  input.value = prefill;
  runSearch(prefill);
  setTimeout(() => input.focus(), 30);
  input.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value.trim()), 220);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#search-results .sr-item');
      if (first) { closeSearch(); location.hash = first.getAttribute('href'); }
    }
    if (e.key === 'Escape') closeSearch();
  };
}

function closeSearch() {
  document.getElementById('search-modal').classList.add('hidden');
}

function highlight(text, q) {
  const t = esc(text);
  if (!q) return t;
  try {
    return t.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
  } catch { return t; }
}

async function runSearch(q) {
  const box = document.getElementById('search-results');
  if (!q) {
    const pop = (App.settings && App.settings.popular_searches) || [];
    box.innerHTML = `<div class="sr-cat">Popular searches</div>` + pop.map(p =>
      `<a class="sr-item" href="#/search/${encodeURIComponent(p)}"><div class="t">${esc(p)}</div></a>`).join('');
    box.querySelectorAll('.sr-item').forEach(a => a.addEventListener('click', closeSearch));
    return;
  }
  box.innerHTML = `<div class="empty">Searching…</div>`;
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    if (!d.results.length) {
      box.innerHTML = `<div class="empty">No results for “${esc(q)}”.<br><a href="#/search/${encodeURIComponent(q)}">View search page</a></div>`;
      return;
    }
    box.innerHTML = `<div class="sr-cat">${d.results.length} result${d.results.length > 1 ? 's' : ''}</div>` + d.results.slice(0, 10).map(r => `
      <a class="sr-item" href="#/article/${esc(r.slug)}">
        <div class="t">${highlight(r.title, q)}</div>
        <div class="s">${r.category ? esc(r.category.name) + ' · ' : ''}${highlight(r.excerpt || '', q)}</div>
      </a>`).join('') + `<a class="sr-item" href="#/search/${encodeURIComponent(q)}"><div class="t" style="color:var(--accent2)">See all results →</div></a>`;
    box.querySelectorAll('.sr-item').forEach(a => a.addEventListener('click', closeSearch));
  } catch (e) {
    box.innerHTML = `<div class="empty">Search failed.</div>`;
  }
}

/* ---------------- generic modal ---------------- */

function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal" id="generic-modal"><div class="modal-box" style="padding:0">${html}</div></div>`;
  document.getElementById('generic-modal').addEventListener('click', (e) => {
    if (e.target.id === 'generic-modal') closeModal();
  });
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

/* ---------------- article cards ---------------- */

function artRow(a) {
  const lock = a.restricted ? ' <span class="lock" title="Restricted article">🔒</span>' : '';
  return `<div class="art-row">
    <a class="t" href="#/article/${esc(a.slug)}">${esc(a.title)}${lock}</a>
    <div class="meta">${a.category ? esc(a.category.name) + ' · ' : ''}${a.service ? esc(a.service.name) + ' · ' : ''}${a.reading_time_min} min${a.updated_at ? ' · ' + timeAgo(a.updated_at) : ''}</div>
  </div>`;
}

/* Category lead visual, BookStack-style: the cover image when one is set
   (rendered as a cover band on the card), otherwise the icon/emoji tile. */
function catCardVisual(c) {
  if (c && c.cover_image) return `<img class="ci-cover" src="${esc(c.cover_image)}" alt="">`;
  return `<span class="ci" style="background:${esc((c && c.color) || '#3B82F6')}22;color:${esc((c && c.color) || '#3B82F6')}">${esc((c && c.icon) || '📄')}</span>`;
}

/* ---------------- views ---------------- */

async function viewHome() {
  const app = document.getElementById('app');
  const s = App.settings;
  const d = await api('/api/home');
  const pop = s.popular_searches || [];

  const cont = await continueReadingCard();

  const overlay = Math.max(0, Math.min(95, parseInt(s.hero_overlay, 10) || 0)) / 100;
  const heroStyle = s.hero_image_url
    ? ` style="background-image:linear-gradient(rgba(5,8,16,${overlay}),rgba(5,8,16,${overlay})),url('${esc(s.hero_image_url)}');background-size:${esc(s.hero_image_fit || 'cover')};background-position:${esc(s.hero_image_position || 'center')};background-repeat:no-repeat"`
    : '';
  const showCards = String(s.hero_show_cards ?? '1') === '1';

  app.innerHTML = `
    <section class="hero"${heroStyle}>
      <h1>${esc(s.hero_title).replace('Knowledge Base', '<span class="hl">Knowledge Base</span>')}</h1>
      <p class="desc">${esc(s.hero_description)}</p>
      <div class="hero-search">
        <input id="hero-q" type="text" placeholder="Search documentation…">
        <button class="btn" id="hero-go">Search</button>
      </div>
      <div class="pop-searches"><span>Popular searches:</span>${pop.map(p => `<button class="chip" data-q="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      ${showCards ? '<div class="hero-cards"><div class="hero-card">XC</div><div class="hero-card">KB</div><div class="hero-card">✦</div></div>' : ''}
    </section>

    <div class="cat-grid">
      ${d.categories.map(c => `
        <a class="cat-card" href="#/category/${esc(c.slug)}">
          ${catCardVisual(c)}
          <strong>${esc(c.name)}</strong><small>${esc(c.description)}</small>
          <span class="arr">→</span>
        </a>`).join('')}
    </div>

    <div class="section">
      <div class="section-head"><div><h2>Your Services</h2><p class="sub">Guides specific to your active services.</p></div>
      <a href="#/services" style="font-size:.8rem">View All My Services →</a></div>
      <div class="svc-grid">
        ${d.services.slice(0, 2).map(svc => `
          <a class="svc-card" href="#/service/${esc(svc.slug)}">
            <span class="si" style="background:${esc(svc.color)}22">${esc(svc.icon)}</span>
            <span><strong>${esc(svc.name)}</strong><small>${esc(svc.description)}</small></span>
            <span class="arr">→</span>
          </a>`).join('')}
      </div>
    </div>

    ${cont}

    <div class="section">
      <div class="section-head"><div><h2>Recommended for You</h2></div></div>
      <div class="art-list">${d.featured.map(artRow).join('') || '<div class="empty">No recommendations yet.</div>'}</div>
    </div>

    <div class="section">
      <div class="section-head"><div><h2>Browse by Service</h2><p class="sub">Select a service to view all available guides.</p></div></div>
      <div class="browse-grid">
        ${d.services.map(svc => `
          <a class="browse-item" href="#/service/${esc(svc.slug)}">
            <span class="bi" style="background:${esc(svc.color)}22">${esc(svc.icon)}</span>${esc(svc.name)}
          </a>`).join('')}
      </div>
    </div>

    <div class="section two-col">
      <div class="panel"><h3>Recently Updated <a href="#/recent">View All →</a></h3><div class="art-list">${d.recent.map(artRow).join('')}</div></div>
      <div class="panel"><h3>Popular Guides <a href="#/popular">View All →</a></h3><div class="art-list">${d.popular.map(artRow).join('')}</div></div>
    </div>`;

  const go = () => {
    const q = document.getElementById('hero-q').value.trim();
    if (q) location.hash = '#/search/' + encodeURIComponent(q);
  };
  document.getElementById('hero-go').onclick = go;
  document.getElementById('hero-q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  app.querySelectorAll('.chip[data-q]').forEach(ch => ch.onclick = () => { location.hash = '#/search/' + encodeURIComponent(ch.dataset.q); });
}

async function continueReadingCard() {
  try {
    const d = await api('/api/progress?anon_key=' + encodeURIComponent(anonKey()));
    const entries = Object.entries(d.progress || {}).filter(([, p]) => p > 0.02 && p < 0.99);
    if (!entries.length) return '';
    // pick the most recently... we only have progress values; fetch the top one by progress desc
    entries.sort((a, b) => b[1] - a[1]);
    const [articleId, p] = entries[0];
    // we need slug+title: fetch via search of nothing — use a lightweight approach: try article endpoint by id is not public.
    // Fallback: store slug in progress? For now, fetch home recent and match.
    const home = await api('/api/home');
    const all = [...home.recent, ...home.popular, ...home.featured];
    const art = all.find(a => String(a.id) === String(articleId));
    if (!art) return '';
    const pct = Math.round(p * 100);
    return `<div class="section"><div class="section-head"><div><h2>Continue Reading</h2></div></div>
      <div class="continue-card">
        <div class="cr-title">${esc(art.title)}</div>
        <div class="cr-step">${pct}% complete</div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div style="margin-top:10px"><a class="link-btn" href="#/article/${esc(art.slug)}">Continue →</a></div>
      </div></div>`;
  } catch { return ''; }
}

async function viewArticle(slug) {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api('/api/articles/' + encodeURIComponent(slug));
  if (d.redirect) { location.hash = '#/article/' + d.redirect; return; }

  document.title = d.title + ' — XC Wiki';
  app.innerHTML = `
    <div class="reading-bar" id="reading-bar"></div>
    <div class="crumbs"><a href="#/">Home</a> › ${d.category ? `<a href="#/category/${esc(d.category.slug)}">${esc(d.category.name)}</a> › ` : ''}${esc(d.title)}</div>
    <div class="article-layout">
      <article class="article-body">
        <h1>${esc(d.title)}</h1>
        <div class="article-meta">
          <span>👁 ${d.views} views</span><span>⏱ ${d.reading_time_min} min read</span>
          ${d.category ? `<span>${(d.category.cover_image || d.category.icon_image) ? `<img src="${esc(d.category.cover_image || d.category.icon_image)}" alt="" style="width:16px;height:16px;object-fit:cover;border-radius:4px;vertical-align:-3px">` : esc(d.category.icon)} ${esc(d.category.name)}</span>` : ''}
          ${d.service ? `<span>${esc(d.service.icon)} ${esc(d.service.name)}</span>` : ''}
          ${d.author_name ? `<span>✍ ${esc(d.author_name)}</span>` : ''}
          <span>Updated ${timeAgo(d.updated_at)}</span>
        </div>
        <div class="md" id="md-body">${d.content_html}</div>
        ${d.attachments && d.attachments.length ? `<div class="attach-box"><h3>Attachments</h3>${d.attachments.map(f => {
          if (f.kind === 'image') return `<figure class="attach-item"><img src="${f.url}" alt="${esc(f.alt_text || f.original_name)}">${f.caption ? `<figcaption>${esc(f.caption)}</figcaption>` : ''}</figure>`;
          if (f.kind === 'video') return `<div class="attach-item"><video controls preload="metadata" src="${f.url}" style="max-width:100%;border-radius:8px"></video><div class="attach-name">${esc(f.title || f.original_name)}</div></div>`;
          if (f.kind === 'audio') return `<div class="attach-item"><div class="attach-name">🎵 ${esc(f.title || f.original_name)}</div><audio controls src="${f.url}" style="width:100%"></audio></div>`;
          return `<div class="attach-item"><a href="${f.url}" download>📎 ${esc(f.title || f.original_name)}</a> <span class="attach-name">${(f.size_bytes / 1024).toFixed(0)} KB</span></div>`;
        }).join('')}</div>` : ''}
        <div class="tag-row">${(d.tags || []).map(t => `<a class="tag" href="#/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('')}</div>
        <div class="feedback-box" id="feedback-box">
          <strong>Was this helpful?</strong>
          <div class="fb-btns">
            <button class="btn ghost small" data-fb="1">👍 Yes</button>
            <button class="btn ghost small" data-fb="0">👎 No</button>
          </div>
        </div>
        <div class="prevnext">
          ${d.prev ? `<a href="#/article/${esc(d.prev.slug)}"><small>← Previous</small>${esc(d.prev.title)}</a>` : '<span></span>'}
          ${d.next ? `<a href="#/article/${esc(d.next.slug)}" style="text-align:right"><small>Next →</small>${esc(d.next.title)}</a>` : '<span></span>'}
        </div>
      </article>
      <aside class="toc" id="toc">
        <strong>On this page</strong>
        ${(d.toc || []).map(t => `<a href="#${esc(t.id)}" class="l${t.level}">${esc(t.text)}</a>`).join('') || '<span style="color:var(--muted2)">No headings</span>'}
      </aside>
    </div>
    ${d.related && d.related.length ? `<div class="section"><div class="section-head"><div><h2>Related articles</h2></div></div><div class="art-list">${d.related.map(artRow).join('')}</div></div>` : ''}`;

  // feedback
  app.querySelectorAll('[data-fb]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/articles/${d.id}/feedback`, { method: 'POST', body: JSON.stringify({ helpful: b.dataset.fb === '1' }) });
      document.getElementById('feedback-box').innerHTML = '<strong>Thanks for your feedback! 🙏</strong>';
    } catch { toast('Could not record feedback', 'err'); }
  });

  // reading progress: bar + save
  const bar = document.getElementById('reading-bar');
  let savedAt = 0;
  const onScroll = () => {
    const body = document.getElementById('md-body');
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const total = body.offsetHeight - window.innerHeight + rect.top;
    const p = total > 0 ? Math.max(0, Math.min(1, (window.scrollY - rect.top + 120) / total)) : 1;
    bar.style.width = (p * 100) + '%';
    if (Date.now() - savedAt > 4000 && p > 0.02) {
      savedAt = Date.now();
      api('/api/progress', { method: 'POST', body: JSON.stringify({ article_id: d.id, progress: p, anon_key: anonKey() }) }).catch(() => {});
    }
    // toc highlight
    const heads = [...body.querySelectorAll('h1[id],h2[id],h3[id],h4[id]')];
    let cur = null;
    for (const h of heads) { if (h.getBoundingClientRect().top < 140) cur = h.id; }
    document.querySelectorAll('#toc a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + cur));
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  App._cleanup = () => window.removeEventListener('scroll', onScroll);
  onScroll();
  // anchor offset for toc links
  app.querySelectorAll('#toc a').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.getElementById(a.getAttribute('href').slice(1));
    if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 110, behavior: 'smooth' });
  }));
}

async function viewTaxonomyList(kind) {
  const app = document.getElementById('app');
  const titles = { categories: 'All Categories', services: 'All Services', tags: 'All Tags' };
  const d = await api('/api/' + kind);
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › ${titles[kind]}</div>
    <h1 style="margin-top:6px">${titles[kind]}</h1>
    <div class="cat-grid" style="grid-template-columns:repeat(3,1fr)">
    ${d.map(x => `
      <a class="cat-card" href="#/${kind === 'categories' ? 'category' : kind === 'services' ? 'service' : 'tag'}/${esc(x.slug)}">
        ${kind === 'categories' ? catCardVisual(x) : `<span class="ci" style="background:${esc(x.color || '#3B82F6')}22;color:${esc(x.color || '#3B82F6')}">${esc(x.icon || '🏷️')}</span>`}
        <strong>${esc(x.name)}</strong><small>${esc(x.description || '')}${x.article_count !== undefined ? ` · ${x.article_count} articles` : ''}</small>
        <span class="arr">→</span>
      </a>`).join('')}
    </div>`;
}

async function viewTaxonomyDetail(kind, slug) {
  const app = document.getElementById('app');
  const single = kind === 'category' ? 'categories' : kind === 'service' ? 'services' : 'tags';
  const d = await api(`/api/${single}/${encodeURIComponent(slug)}`);
  const obj = d[kind];
  const hasCover = kind === 'category' && obj.cover_image;
  const headIcon = hasCover ? ''
    : kind === 'category' && obj.icon_image
      ? `<img src="${esc(obj.icon_image)}" alt="" style="width:30px;height:30px;object-fit:cover;border-radius:8px;vertical-align:-6px">`
      : esc(obj.icon || '');
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › <a href="#/${single}">${single[0].toUpperCase() + single.slice(1)}</a> › ${esc(obj.name)}</div>
    ${hasCover ? `<img class="cat-banner" src="${esc(obj.cover_image)}" alt="">` : ''}
    <h1 style="margin-top:6px">${headIcon} ${esc(obj.name)}</h1>
    ${obj.description ? `<p style="color:var(--muted)">${esc(obj.description)}</p>` : ''}
    <div class="art-list" style="margin-top:14px">${d.articles.map(artRow).join('') || '<div class="empty">No articles yet.</div>'}</div>`;
}

async function viewSearchPage(q) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Search</div><h1>Search</h1><div class="empty">Searching…</div>`;
  const d = await api('/api/search?q=' + encodeURIComponent(q));
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Search</div>
    <h1 style="margin-top:6px">Results for “${esc(q)}”</h1>
    <p style="color:var(--muted)">${d.results.length} result${d.results.length === 1 ? '' : 's'}</p>
    <div class="art-list">${d.results.map(r => `
      <div class="art-row"><a class="t" href="#/article/${esc(r.slug)}">${highlight(r.title, q)}</a>
      <div class="meta">${r.category ? esc(r.category.name) + ' · ' : ''}${highlight(r.excerpt || '', q)}</div></div>`).join('') || '<div class="empty">No results found. Try different keywords.</div>'}</div>`;
}

async function viewArticleListPage(kind) {
  const app = document.getElementById('app');
  const d = await api('/api/home');
  const list = kind === 'popular' ? d.popular : d.recent;
  const title = kind === 'popular' ? 'Popular Guides' : 'Recently Updated';
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › ${title}</div>
    <h1 style="margin-top:6px">${title}</h1>
    <div class="art-list" style="margin-top:12px">${list.map(artRow).join('')}</div>`;
}

/* ---------------- auth views ---------------- */

async function viewSetup() {
  const app = document.getElementById('app');
  const { needed } = await api('/api/setup-needed');
  if (!needed) { location.hash = '#/login'; return; }
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1>🚀 Welcome to XC Wiki</h1>
    <p class="sub">Create the first administrator account to get started.</p>
    <form id="setup-form">
      <label class="fld"><span>Display name</span><input name="display_name" required></label>
      <label class="fld"><span>Email</span><input name="email" type="email" required></label>
      <label class="fld"><span>Password (8+ characters)</span><input name="password" type="password" minlength="8" required></label>
      <button class="btn" style="width:100%;margin-top:8px">Create admin account</button>
      <p class="form-error" id="setup-err" style="color:var(--red);font-size:.82rem"></p>
    </form></div></div>`;
  document.getElementById('setup-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const d = await api('/api/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      App.token = d.token; store.set('xcwiki_token', d.token); App.user = d.user;
      renderUserArea(); toast('Admin account created', 'ok'); location.hash = '#/admin';
    } catch (err) { document.getElementById('setup-err').textContent = err.message; }
  };
}

async function viewLogin() {
  const app = document.getElementById('app');
  /* First run: no staff account exists yet, so the staff login page IS the
     setup page — the installer creates the administrator account here. */
  let needed = App.setupNeeded;
  if (needed === undefined) {
    try { needed = (await api('/api/setup-needed')).needed; App.setupNeeded = needed; } catch { needed = false; }
  }
  if (needed) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1>🚀 Welcome to XC Wiki</h1>
    <p class="sub">This wiki hasn't been set up yet. Create the first administrator account to get started — you'll sign in with it from then on.</p>
    <form id="setup-form">
      <label class="fld"><span>Display name</span><input name="display_name" required></label>
      <label class="fld"><span>Email</span><input name="email" type="email" required></label>
      <label class="fld"><span>Password (8+ characters)</span><input name="password" type="password" minlength="8" required></label>
      <button class="btn" style="width:100%;margin-top:8px">Create admin account</button>
      <p class="form-error" id="setup-err" style="color:var(--red);font-size:.82rem"></p>
    </form></div></div>`;
    document.getElementById('setup-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const d = await api('/api/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
        App.token = d.token; store.set('xcwiki_token', d.token); App.user = d.user; App.setupNeeded = false;
        renderUserArea(); toast('Admin account created', 'ok'); location.hash = '#/admin';
      } catch (err) { document.getElementById('setup-err').textContent = err.message; }
    };
    return;
  }
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1>Staff Login</h1>
    <p class="sub">Editors and admins sign in here. This is a private wiki — customers use the <a href="#/customer-login">customer sign-in</a> with their own accounts.</p>
    <form id="login-form">
      <label class="fld"><span>Email</span><input name="email" type="email" required></label>
      <label class="fld"><span>Password</span><input name="password" type="password" required></label>
      <button class="btn" style="width:100%;margin-top:8px">Sign in</button>
      <p id="login-err" style="color:var(--red);font-size:.82rem"></p>
    </form></div></div>`;
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      App.token = d.token; store.set('xcwiki_token', d.token); App.user = d.user;
      renderUserArea(); toast('Signed in', 'ok'); location.hash = '#/admin';
    } catch (err) { document.getElementById('login-err').textContent = err.message; }
  };
}

function viewCustomerLogin() {
  const app = document.getElementById('app');
  if (App.user && App.user.kind === 'customer') { location.hash = '#/account'; return; }
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1>Customer Login</h1>
    <p class="sub">This is a private wiki. Sign in with the account your administrator invited you with — check your email for the password-setup link if it's your first time.</p>
    <form id="clogin-form">
      <label class="fld"><span>Email</span><input name="email" type="email" required></label>
      <label class="fld"><span>Password</span><input name="password" type="password" required></label>
      <button class="btn" style="width:100%;margin-top:8px">Sign in</button>
      <p id="clogin-err" style="color:var(--red);font-size:.82rem"></p>
    </form>
    <p class="sub" style="margin-top:14px">Staff? <a href="#/login">Sign in here →</a></p>
    </div></div>`;
  document.getElementById('clogin-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const d = await api('/api/customer/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      App.token = d.token; store.set('xcwiki_token', d.token); App.user = d.user;
      renderUserArea(); toast('Signed in', 'ok'); location.hash = '#/';
    } catch (err) { document.getElementById('clogin-err').textContent = err.message; }
  };
}

async function viewSetPassword(token) {
  const app = document.getElementById('app');
  if (!token) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Set your password</h1>
      <p class="sub">This link is missing its security token. Ask your administrator to send you a new password-setup link.</p></div></div>`;
    return;
  }
  let info = null;
  try { info = await api('/api/customer/set-password-info?token=' + encodeURIComponent(token)); } catch (e) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Set your password</h1>
      <p class="sub">${esc(e.message)}</p>
      <p class="sub"><a href="#/customer-login">← Back to sign in</a></p></div></div>`;
    return;
  }
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1>Set your password</h1>
    <p class="sub">Welcome${info.name ? ' ' + esc(info.name) : ''} — choose a password for <strong>${esc(info.email)}</strong> to finish setting up your account.</p>
    <form id="setpw-form">
      <label class="fld"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" required></label>
      <label class="fld"><span>Confirm password</span><input name="confirm" type="password" minlength="8" required></label>
      <button class="btn" style="width:100%;margin-top:8px">Set password &amp; continue</button>
      <p id="setpw-err" style="color:var(--red);font-size:.82rem"></p>
    </form></div></div>`;
  document.getElementById('setpw-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pw = String(fd.get('password') || '');
    if (pw !== String(fd.get('confirm') || '')) {
      document.getElementById('setpw-err').textContent = 'The two passwords do not match.';
      return;
    }
    try {
      await api('/api/customer/set-password', { method: 'POST', body: JSON.stringify({ token, password: pw }) });
      toast('Password set — sign in to continue', 'ok');
      location.hash = '#/customer-login';
    } catch (err) { document.getElementById('setpw-err').textContent = err.message; }
  };
}

async function viewAccount() {
  const app = document.getElementById('app');
  if (!App.user || App.user.kind !== 'customer') { location.hash = '#/customer-login'; return; }
  const u = App.user;
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › My Account</div>
    <h1 style="margin-top:6px">My Account</h1>
    <div class="two-col" style="margin-top:14px">
      <div class="panel"><h3>Profile</h3>
        <p><strong>${esc(u.name)}</strong><br>
        <span style="color:var(--muted);font-size:.85rem">${esc(u.email)}</span><br>
        ${u.company ? `<span style="color:var(--muted);font-size:.85rem">${esc(u.company)}</span><br>` : ''}
        ${u.group_name ? `<span class="pill published" style="margin-top:6px;display:inline-block">${esc(u.group_name)}</span>` : ''}</p>
        <button class="btn ghost small" id="acc-logout">Sign out</button>
      </div>
      <div class="panel"><h3>Change password</h3>
        <form id="pw-form">
          <label class="fld"><span>Current password</span><input name="current" type="password" required></label>
          <label class="fld"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" required></label>
          <button class="btn small">Update password</button>
          <p id="pw-err" style="color:var(--red);font-size:.82rem"></p>
        </form>
      </div>
    </div>`;
  document.getElementById('acc-logout').onclick = async () => {
    await api('/api/customer/logout', { method: 'POST' }).catch(() => {});
    App.token = ''; store.remove('xcwiki_token'); App.user = null;
    renderUserArea(); location.hash = '#/';
  };
  document.getElementById('pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/customer/password', { method: 'PUT', body: JSON.stringify(Object.fromEntries(fd)) });
      toast('Password updated', 'ok'); e.target.reset();
      document.getElementById('pw-err').textContent = '';
    } catch (err) { document.getElementById('pw-err').textContent = err.message; }
  };
}

/* ---------------- router ---------------- */

function setActiveNav(name) {
  document.querySelectorAll('.mainnav [data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
}

async function route() {
  if (App._cleanup) { App._cleanup(); App._cleanup = null; }
  window.scrollTo(0, 0);
  document.getElementById('search-modal').classList.add('hidden');
  const hash = location.hash || '#/';
  const [pathOnly, queryOnly] = hash.replace(/^#\//, '').split('?');
  const parts = pathOnly.split('/');
  const query = new URLSearchParams(queryOnly || '');
  /* Login wall: this wiki is private. Signed-out visitors only ever reach
     the sign-in screens (and first-run setup / password-setup links). */
  if (!App.user) {
    if (App.setupNeeded && parts[0] !== 'login' && parts[0] !== 'setup') { location.hash = '#/login'; return; }
    if (!App.setupNeeded && !['login', 'customer-login', 'setup', 'set-password'].includes(parts[0])) { location.hash = '#/customer-login'; return; }
  }
  const app = document.getElementById('app');
  try {
    if (parts[0] === '' ) { document.title = 'XC Wiki Knowledge Base'; setActiveNav('overview'); await viewHome(); }
    else if (parts[0] === 'article' && parts[1]) { setActiveNav(''); await viewArticle(decodeURIComponent(parts[1])); }
    else if (parts[0] === 'category' && parts[1]) { setActiveNav(''); await viewTaxonomyDetail('category', decodeURIComponent(parts[1])); }
    else if (parts[0] === 'service' && parts[1]) { setActiveNav(''); await viewTaxonomyDetail('service', decodeURIComponent(parts[1])); }
    else if (parts[0] === 'tag' && parts[1]) { setActiveNav(''); await viewTaxonomyDetail('tag', decodeURIComponent(parts[1])); }
    else if (['categories', 'services', 'tags'].includes(parts[0])) { setActiveNav(parts[0] === 'services' ? 'all-services' : ''); await viewTaxonomyList(parts[0]); }
    else if (parts[0] === 'popular' || parts[0] === 'recent') { setActiveNav(''); await viewArticleListPage(parts[0]); }
    else if (parts[0] === 'search' && parts[1]) { setActiveNav(''); await viewSearchPage(decodeURIComponent(parts.slice(1).join('/'))); }
    else if (parts[0] === 'setup') { setActiveNav(''); await viewSetup(); }
    else if (parts[0] === 'login') { setActiveNav(''); await viewLogin(); }
    else if (parts[0] === 'customer-login') { setActiveNav(''); viewCustomerLogin(); }
    else if (parts[0] === 'set-password') { setActiveNav(''); await viewSetPassword(query.get('token') || ''); }
    else if (parts[0] === 'account') { setActiveNav(''); await viewAccount(); }
    else if (parts[0] === 'admin') {
      setActiveNav('');
      if (!App.user) { location.hash = '#/login'; return; }
      await AdminView.route(parts.slice(1));
    }
    else { app.innerHTML = '<div class="empty"><h2>Page not found</h2><a href="#/">Back home</a></div>'; }
  } catch (e) {
    app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back home</a></div>`;
  }
  document.getElementById('mainnav').classList.remove('open');
}

/* ---------------- boot ---------------- */

async function boot() {
  const [settings, setupNeeded] = await Promise.all([
    api('/api/settings/public').catch(() => null),
    api('/api/setup-needed').catch(() => ({ needed: false })),
  ]);
  App.settings = settings || {};
  if (settings) {
    applyBranding(settings);
    document.getElementById('brand-title').textContent = settings.logo_text || settings.site_title;
    document.getElementById('brand-tagline').textContent = settings.site_tagline;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.content = settings.hero_description;
  }
  initTheme();
  await loadMe();
  renderUserArea();

  document.getElementById('search-trigger').onclick = () => openSearch();
  document.getElementById('search-close').onclick = closeSearch;
  document.getElementById('search-modal').addEventListener('click', (e) => {
    if (e.target.id === 'search-modal') closeSearch();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  });
  document.getElementById('nav-toggle').onclick = () => document.getElementById('mainnav').classList.toggle('open');
  document.getElementById('preview-exit').onclick = () => setPreviewMode(false);

  window.addEventListener('hashchange', route);
  const { needed } = setupNeeded;
  App.setupNeeded = needed;
  if (needed && !location.hash) location.hash = '#/login';
  await route();
}

document.addEventListener('DOMContentLoaded', boot);
