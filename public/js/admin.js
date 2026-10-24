'use strict';
/* XC Wiki — staff admin dashboard. */

const AdminView = {
  tax: { categories: [], services: [] },
  groups: [],

  async route(parts) {
    const app = document.getElementById('app');
    const view = parts[0] || 'dashboard';
    await this.loadTax();
    try { this.groups = await api('/api/admin/groups'); } catch { this.groups = []; }
    const nav = [
      ['dashboard', '📊 Dashboard'], ['articles', '📝 Articles'], ['categories', '📁 Categories'],
      ['services', '🖥️ Services'], ['tags', '🏷️ Tags'], ['media', '🖼️ Media'],
      ['customers', '🙋 Customers'], ['groups', '👪 Groups'],
      ['redirects', '↪ Redirects'], ['feedback', '💬 Feedback'], ['search', '🔍 Search Analytics'],
      ['branding', '🎨 Branding'], ['backup', '☁️ Cloud Backup'], ['bookstack', '📚 BookStack Import'],
      ['demo', '🧪 Demo Content'], ['users', '👥 Users'], ['viewas', '👁 View As'], ['settings', '⚙️ Settings'],
    ];
    app.innerHTML = `
      <div class="crumbs"><a href="#/">Knowledge Base</a> › Staff Dashboard</div>
      <div class="admin-layout">
        <aside class="admin-nav">${nav.map(([k, l]) => `<a href="#/admin/${k}" data-av="${k}">${l}</a>`).join('')}</aside>
        <div id="admin-main"></div>
      </div>`;
    app.querySelectorAll('.admin-nav a').forEach(a => a.classList.toggle('active', a.dataset.av === view));
    const main = document.getElementById('admin-main');
    try {
      if (view === 'dashboard') await this.dashboard(main);
      else if (view === 'articles') await this.articles(main);
      else if (view === 'article' && parts[1]) await this.editor(main, parts[1]);
      else if (view === 'versions' && parts[1]) await this.versions(main, parts[1]);
      else if (view === 'categories') await this.taxManager(main, 'categories');
      else if (view === 'services') await this.taxManager(main, 'services');
      else if (view === 'tags') await this.tagsManager(main);
      else if (view === 'media') await this.media(main);
      else if (view === 'customers') await this.customers(main);
      else if (view === 'groups') await this.groupsManager(main);
      else if (view === 'redirects') await this.redirects(main);
      else if (view === 'feedback') await this.feedback(main);
      else if (view === 'search') await this.searchAnalytics(main);
      else if (view === 'branding') await this.branding(main);
      else if (view === 'backup') await this.backup(main);
      else if (view === 'bookstack') await this.bookstack(main);
      else if (view === 'demo') await this.demoContent(main);
      else if (view === 'users') await this.users(main);
      else if (view === 'viewas') await this.viewAs(main);
      else if (view === 'settings') await this.settings(main);
      else main.innerHTML = '<div class="empty">Unknown admin view.</div>';
    } catch (e) {
      main.innerHTML = `<div class="empty"><h3>Error</h3><p>${esc(e.message)}</p></div>`;
    }
  },

  async loadTax() {
    const [c, s] = await Promise.all([api('/api/admin/categories'), api('/api/admin/services')]);
    this.tax = { categories: c, services: s };
  },

  visPill(v) {
    const map = { all: ['published', '🌍 Everyone'], groups: ['scheduled', '👪 Groups'], staff: ['archived', '🔒 Staff only'] };
    const [cls, label] = map[v] || map.all;
    return `<span class="pill ${cls}">${label}</span>`;
  },

  /* ---------- dashboard ---------- */

  async dashboard(main) {
    const d = await api('/api/admin/stats');
    main.innerHTML = `
      <h2 style="margin-top:0">Dashboard</h2>
      <div class="stat-grid">
        <div class="stat"><div class="n">${d.articles}</div><div class="l">Total articles</div></div>
        <div class="stat"><div class="n">${d.published}</div><div class="l">Published</div></div>
        <div class="stat"><div class="n">${d.drafts}</div><div class="l">Drafts / scheduled</div></div>
        <div class="stat"><div class="n">${d.views.toLocaleString()}</div><div class="l">Total views</div></div>
        <div class="stat"><div class="n">${d.customers}</div><div class="l">Customers</div></div>
        <div class="stat"><div class="n">${d.groups}</div><div class="l">Customer groups</div></div>
      </div>
      <div class="two-col">
        <div class="panel"><h3>Feedback score</h3>
          <div style="font-size:2rem;font-weight:800">${d.feedback_score === null ? '—' : d.feedback_score + '%'}</div>
          <div style="color:var(--muted);font-size:.82rem">${d.feedback_votes} votes · “Was this helpful?”</div>
          <div style="margin-top:10px"><a class="btn ghost small" href="#/admin/feedback">Open feedback inbox</a></div>
        </div>
        <div class="panel"><h3>Quick actions</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <a class="btn small" href="#/admin/article/new">＋ New article</a>
            <a class="btn ghost small" href="#/admin/customers">＋ New customer</a>
            <a class="btn ghost small" href="#/admin/media">Upload media</a>
            <a class="btn ghost small" href="#/admin/backup">☁️ Backup now</a>
            <button class="btn ghost small" id="q-export">Export JSON</button>
          </div>
        </div>
      </div>
      <div class="panel" style="margin-top:14px"><h3>Recent activity</h3>
        <div class="art-list">${d.activity.map(a => `
          <div class="art-row"><div class="t" style="font-weight:600;font-size:.86rem">${esc(a.action.replace(/_/g, ' '))}</div>
          <div class="meta">${esc(a.details || '')} · ${esc(a.display_name || 'system')} · ${timeAgo(a.created_at)}</div></div>`).join('') || '<div class="empty">No activity yet.</div>'}
        </div>
      </div>`;
    document.getElementById('q-export').onclick = () => { window.location = '/api/admin/export'; };
  },

  /* ---------- articles ---------- */

  async articles(main) {
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">Articles</h2>
        <a class="btn small" href="#/admin/article/new">＋ New article</a>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <input type="text" id="f-q" placeholder="Search title/slug…" style="max-width:220px">
        <select id="f-status" style="max-width:160px">
          <option value="">All statuses</option><option value="published">Published</option>
          <option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="archived">Archived</option>
        </select>
        <select id="f-vis" style="max-width:170px">
          <option value="">All visibility</option><option value="all">🌍 Everyone</option>
          <option value="groups">👪 Groups</option><option value="staff">🔒 Staff only</option>
        </select>
        <select id="f-cat" style="max-width:180px"><option value="">All categories</option>${this.tax.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <button class="btn ghost small" id="f-go">Filter</button>
      </div>
      <div class="toolbar" id="bulk-bar" style="display:none">
        <span id="bulk-count" style="font-size:.85rem;color:var(--muted)"></span>
        <button class="btn ghost small" data-bulk="publish">Publish</button>
        <button class="btn ghost small" data-bulk="unpublish">Unpublish</button>
        <button class="btn ghost small" data-bulk="archive">Archive</button>
        <button class="btn ghost small" data-bulk="set-visibility">👁 Set visibility…</button>
        <button class="btn danger small" data-bulk="delete">Delete</button>
      </div>
      <div style="overflow-x:auto"><table class="tbl"><thead><tr>
        <th><input type="checkbox" id="sel-all"></th><th>Title</th><th>Status</th><th>Visibility</th><th>Category</th><th>Views</th><th>Updated</th><th></th>
      </tr></thead><tbody id="art-rows"></tbody></table></div>`;

    const load = async () => {
      const q = new URLSearchParams();
      const v = id => document.getElementById(id).value;
      if (v('f-q')) q.set('q', v('f-q'));
      if (v('f-status')) q.set('status', v('f-status'));
      if (v('f-vis')) q.set('visibility', v('f-vis'));
      if (v('f-cat')) q.set('category_id', v('f-cat'));
      const rows = await api('/api/admin/articles?' + q.toString());
      const tb = document.getElementById('art-rows');
      tb.innerHTML = rows.map(a => `
        <tr>
          <td><input type="checkbox" class="sel" value="${a.id}"></td>
          <td><a href="#/admin/article/${a.id}" style="color:var(--text);font-weight:600">${esc(a.title)}</a><br><small style="color:var(--muted2)">/${esc(a.slug)}</small></td>
          <td><span class="pill ${a.status}">${a.status}</span>${a.featured ? ' ⭐' : ''}</td>
          <td>${this.visPill(a.visibility)}${a.visibility === 'groups' ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${(a.groups || []).map(g => `<span class="pill" style="background:${esc(g.color || '#8B5CF6')}22;color:${esc(g.color || '#8B5CF6')}">${esc(g.name)}</span>`).join('') || '<span style="color:var(--red);font-size:.75rem">no group!</span>'}</div>` : ''}</td>
          <td>${a.category ? esc(a.category.name) : '—'}</td>
          <td>${a.views}</td>
          <td style="white-space:nowrap">${timeAgo(a.updated_at)}</td>
          <td style="white-space:nowrap">
            ${a.status === 'draft' ? `<button class="link-btn" data-pub="${a.id}" style="color:var(--green);font-weight:700">Publish</button> · ` : ''}
            <a class="link-btn" href="#/article/${esc(a.slug)}" target="_blank">View</a> ·
            <a class="link-btn" href="#/admin/versions/${a.id}">History</a> ·
            <button class="link-btn" data-del="${a.id}" style="color:var(--red)">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">No articles.</td></tr>';
      tb.querySelectorAll('[data-pub]').forEach(b => b.onclick = async () => {
        try {
          await api('/api/admin/articles/bulk', { method: 'POST', body: JSON.stringify({ ids: [Number(b.dataset.pub)], action: 'publish' }) });
          toast('Article published', 'ok'); load();
        } catch (e) { toast(e.message, 'err'); }
      });
      tb.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this article permanently? This cannot be undone.')) return;
        await api('/api/admin/articles/' + b.dataset.del, { method: 'DELETE' });
        toast('Article deleted', 'ok'); load();
      });
      const updateBulk = () => {
        const n = tb.querySelectorAll('.sel:checked').length;
        document.getElementById('bulk-bar').style.display = n ? 'flex' : 'none';
        document.getElementById('bulk-count').textContent = `${n} selected`;
      };
      tb.querySelectorAll('.sel').forEach(c => c.onchange = updateBulk);
      document.getElementById('sel-all').onchange = (e) => {
        tb.querySelectorAll('.sel').forEach(c => c.checked = e.target.checked); updateBulk();
      };
    };
    document.getElementById('f-go').onclick = load;
    document.getElementById('f-q').onkeydown = (e) => { if (e.key === 'Enter') load(); };
    main.querySelectorAll('[data-bulk]').forEach(b => b.onclick = async () => {
      const ids = [...document.querySelectorAll('.sel:checked')].map(c => Number(c.value));
      if (!ids.length) return;
      if (b.dataset.bulk === 'delete' && !confirm(`Permanently delete ${ids.length} article(s)?`)) return;
      if (b.dataset.bulk === 'set-visibility') { this.bulkVisibility(ids, load); return; }
      const r = await api('/api/admin/articles/bulk', { method: 'POST', body: JSON.stringify({ ids, action: b.dataset.bulk }) });
      toast(`${r.affected} article(s) updated`, 'ok'); load();
    });
    await load();
  },

  bulkVisibility(ids, reload) {
    openModal(`<div style="padding:20px;min-width:300px">
      <h3 style="margin-top:0">Set visibility for ${ids.length} article(s)</h3>
      <div class="check-row"><input type="radio" name="bv" value="all" id="bv-all" checked> <label for="bv-all">🌍 Everyone</label></div>
      <div class="check-row"><input type="radio" name="bv" value="groups" id="bv-groups"> <label for="bv-groups">👪 Customer groups</label></div>
      <div id="bv-pick" style="margin:6px 0 6px 26px;display:none;flex-wrap:wrap;gap:6px">
        ${this.groups.map(g => `<label class="chip-pick"><input type="checkbox" class="bv-g" value="${g.id}"> ${esc(g.name)}</label>`).join('') || '<small>No groups yet — create one first.</small>'}
      </div>
      <div class="check-row"><input type="radio" name="bv" value="staff" id="bv-staff"> <label for="bv-staff">🔒 Staff only</label></div>
      <div style="display:flex;gap:8px;margin-top:14px"><button class="btn small" id="bv-go">Apply</button><button class="btn ghost small" id="bv-cancel">Cancel</button></div>
    </div>`);
    document.querySelectorAll('input[name="bv"]').forEach(r => r.onchange = () => {
      document.getElementById('bv-pick').style.display = document.querySelector('input[name="bv"]:checked').value === 'groups' ? 'flex' : 'none';
    });
    document.getElementById('bv-cancel').onclick = closeModal;
    document.getElementById('bv-go').onclick = async () => {
      const visibility = document.querySelector('input[name="bv"]:checked').value;
      const group_ids = [...document.querySelectorAll('.bv-g:checked')].map(c => Number(c.value));
      try {
        const r = await api('/api/admin/articles/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'set-visibility', visibility, group_ids }) });
        closeModal(); toast(`${r.affected} article(s) updated`, 'ok'); reload();
      } catch (e) { toast(e.message, 'err'); }
    };
  },

  /* ---------- media helpers & picker (editor + library) ---------- */

  async uploadFiles(fileList, articleId) {
    const fd = new FormData();
    for (const f of fileList) fd.append('files', f);
    if (articleId) fd.append('article_id', articleId);
    const res = await fetch('/api/admin/upload-multi', { method: 'POST', headers: { 'Authorization': 'Bearer ' + App.token }, body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Upload failed');
    return d.files;
  },

  mediaSnippet(f) {
    const alt = esc(f.alt_text || f.title || f.original_name || '');
    if (f.kind === 'image') {
      const img = `<img src="${f.url}" alt="${alt}">`;
      return f.caption ? `<figure>${img}<figcaption>${esc(f.caption)}</figcaption></figure>` : img;
    }
    if (f.kind === 'video') return `<video controls preload="metadata" src="${f.url}"></video>`;
    if (f.kind === 'audio') return `<audio controls src="${f.url}"></audio>`;
    return `<a href="${f.url}">${esc(f.title || f.original_name || 'Download file')}</a>`;
  },

  /** Library picker: choose an existing upload or upload in place.
      opts: { kind: 'image'|'video'|'audio'|'file'|'all', title, cb(file) } */
  openMediaPicker(opts = {}) {
    const kind = opts.kind || 'all';
    const wantKind = kind === 'file' ? null : kind; // "file" insert accepts any kind
    openModal(`<div style="padding:20px;max-width:720px">
      <h3 style="margin-top:0">${esc(opts.title || 'Choose from Media Library')}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input type="text" id="mp-q" placeholder="Search files…" style="flex:1;min-width:160px">
        <label class="btn ghost small" style="cursor:pointer">⬆ Upload new<input type="file" id="mp-file" ${kind === 'image' ? 'accept="image/*"' : kind === 'video' ? 'accept="video/*"' : kind === 'audio' ? 'accept="audio/*"' : ''} multiple style="display:none"></label>
        <button class="btn ghost small" id="mp-cancel">Cancel</button>
      </div>
      <div id="mp-status" style="font-size:.8rem;color:var(--muted);margin-bottom:8px"></div>
      <div id="mp-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;max-height:52vh;overflow:auto"><div class="empty">Loading…</div></div>
    </div>`);
    const grid = document.getElementById('mp-grid');
    let all = [];
    const render = () => {
      const q = document.getElementById('mp-q').value.trim().toLowerCase();
      const files = all.filter(f => (!wantKind || f.kind === wantKind) &&
        (!q || (f.original_name + ' ' + (f.title || '')).toLowerCase().includes(q)));
      grid.innerHTML = files.map(f => `
        <button class="med-pick" data-id="${f.id}" style="border:1px solid var(--border);border-radius:10px;padding:6px;background:var(--card);cursor:pointer;text-align:left">
          ${f.kind === 'image' ? `<img src="${f.url}" style="width:100%;height:70px;object-fit:cover;border-radius:6px">`
            : f.kind === 'video' ? `<video src="${f.url}" preload="metadata" style="width:100%;height:70px;object-fit:cover;border-radius:6px;background:#000"></video>`
            : `<div style="height:70px;display:flex;align-items:center;justify-content:center;font-size:1.7rem">${f.kind === 'audio' ? '🎵' : '📎'}</div>`}
          <div style="font-size:.68rem;margin-top:4px;word-break:break-all;color:var(--text)">${esc(f.title || f.original_name)}</div>
          <div style="font-size:.62rem;color:var(--muted2)">${esc(f.kind)} · ${(f.size_bytes / 1024).toFixed(0)} KB</div>
        </button>`).join('') || '<div class="empty">No matching files — upload one above.</div>';
      grid.querySelectorAll('.med-pick').forEach(b => b.onclick = () => {
        const f = all.find(x => String(x.id) === b.dataset.id);
        closeModal();
        if (f && opts.cb) opts.cb(f);
      });
    };
    const loadLib = async () => { all = await api('/api/admin/attachments'); render(); };
    loadLib().catch(e => { grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
    document.getElementById('mp-q').oninput = render;
    document.getElementById('mp-cancel').onclick = closeModal;
    document.getElementById('mp-file').onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const st = document.getElementById('mp-status');
      st.textContent = `Uploading ${files.length} file(s)…`;
      try {
        const up = await this.uploadFiles(files);
        if (up.length === 1 && opts.cb) { closeModal(); opts.cb(up[0]); return; }
        st.textContent = `Uploaded ${up.length} file(s) — click one to insert.`;
        await loadLib();
      } catch (err) { st.textContent = 'Upload failed: ' + err.message; }
    };
  },

  insertMediaFlow(kind, insert) {
    this.openMediaPicker({
      kind,
      title: kind === 'image' ? 'Insert image' : kind === 'video' ? 'Insert video' : 'Insert file',
      cb: (f) => { insert(this.mediaSnippet(f)); toast('Inserted', 'ok'); },
    });
  },

  /* ---------- editor (WYSIWYG) ---------- */

  async editor(main, id) {
    const isNew = id === 'new';
    let a = null;
    if (!isNew) a = await api('/api/admin/articles/' + id);
    const vis = a?.visibility || 'all';
    const selGroups = new Set(a?.group_ids || []);
    main.innerHTML = `
      <div class="crumbs"><a href="#/admin/articles">Articles</a> › ${isNew ? 'New' : 'Edit'}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">${isNew ? 'New article' : 'Edit article'}</h2>
        <div style="display:flex;gap:8px">
          ${!isNew ? `<a class="btn ghost small" href="#/admin/versions/${a.id}">🕘 History</a>
          <a class="btn ghost small" href="#/article/${esc(a.slug)}" target="_blank">View live</a>` : ''}
          ${isNew ? '<button class="btn ghost small" id="ed-draft">Save as draft</button>' : ''}
          <button class="btn small" id="ed-save">${isNew ? '💾 Save & Publish' : '💾 Save'}</button>
        </div>
      </div>
      <div class="form-row" style="margin-top:12px">
        <label class="fld"><span>Title</span><input id="ed-title" value="${esc(a?.title || '')}"></label>
        <label class="fld"><span>Slug (auto if blank; renaming keeps a redirect)</span><input id="ed-slug" value="${esc(a?.slug || '')}" placeholder="auto-generated"></label>
      </div>
      <div class="form-row3">
        <label class="fld"><span>Category</span><select id="ed-cat"><option value="">—</option>${this.tax.categories.map(c => `<option value="${c.id}" ${a?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Service</span><select id="ed-svc"><option value="">—</option>${this.tax.services.map(s => `<option value="${s.id}" ${a?.service_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Status</span><select id="ed-status">
          ${['draft', 'published', 'scheduled', 'archived'].map(s => `<option ${a?.status === s ? 'selected' : (!a && s === 'published' ? 'selected' : '')}>${s}</option>`).join('')}
        </select></label>
      </div>
      <div class="panel" style="margin:12px 0"><h3 style="margin-top:0">👁 Visibility</h3>
        <div class="check-row"><input type="radio" name="ed-vis" value="all" id="ev-all" ${vis === 'all' ? 'checked' : ''}> <label for="ev-all"><strong>Everyone</strong> — public, including anonymous visitors</label></div>
        <div class="check-row"><input type="radio" name="ed-vis" value="groups" id="ev-groups" ${vis === 'groups' ? 'checked' : ''}> <label for="ev-groups"><strong>Customer groups</strong> — only signed-in customers in the selected groups</label></div>
        <div id="ev-pick" style="margin:6px 0 6px 26px;display:${vis === 'groups' ? 'flex' : 'none'};flex-wrap:wrap;gap:6px">
          ${this.groups.map(g => `<label class="chip-pick"><input type="checkbox" class="ed-group" value="${g.id}" ${selGroups.has(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') || '<small style="color:var(--muted)">No groups yet — <a href="#/admin/groups">create one</a> first.</small>'}
        </div>
        <div class="check-row"><input type="radio" name="ed-vis" value="staff" id="ev-staff" ${vis === 'staff' ? 'checked' : ''}> <label for="ev-staff"><strong>Staff only</strong> — hidden from every reader</label></div>
      </div>
      <div class="form-row">
        <label class="fld"><span>Tags (comma separated)</span><input id="ed-tags" value="${esc((a?.tags || []).join(', '))}" placeholder="login, setup"></label>
        <label class="fld"><span>Publish at (for scheduled)</span><input id="ed-sched" type="datetime-local" value="${a?.scheduled_at ? esc(a.scheduled_at.slice(0, 16)) : ''}"></label>
      </div>
      <div class="check-row"><input type="checkbox" id="ed-feat" ${a?.featured ? 'checked' : ''}> <label for="ed-feat">Featured (shows in Recommended)</label></div>
      <div class="check-row"><input type="checkbox" id="ed-pin" ${a?.pinned ? 'checked' : ''}> <label for="ed-pin">Pinned to top of lists</label></div>
      <div class="fld"><span style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:6px;font-weight:600">Insert media (hosted in the Media Library)</span>
        <span style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" id="ed-ins-image" type="button">🖼️ Image</button>
          <button class="btn ghost small" id="ed-ins-video" type="button">🎬 Video</button>
          <button class="btn ghost small" id="ed-ins-file" type="button">📎 File</button>
        </span>
        <small style="color:var(--muted)">Pick an existing upload or upload in place — the same buttons live in the editor toolbar.</small>
      </div>
      <div id="wysi-mount" style="margin-top:10px"></div>`;

    document.querySelectorAll('input[name="ed-vis"]').forEach(r => r.onchange = () => {
      document.getElementById('ev-pick').style.display = document.querySelector('input[name="ed-vis"]:checked').value === 'groups' ? 'flex' : 'none';
    });

    const ed = createWysiwyg(document.getElementById('wysi-mount'), {
      initialHtml: a?.content_html || '',
      onInsertMedia: (kind, insert) => this.insertMediaFlow(kind, insert),
    });

    const insertAtCursor = (html) => { ed.focus(); document.execCommand('insertHTML', false, html + '<p></p>'); };
    document.getElementById('ed-ins-image').onclick = () => this.insertMediaFlow('image', insertAtCursor);
    document.getElementById('ed-ins-video').onclick = () => this.insertMediaFlow('video', insertAtCursor);
    document.getElementById('ed-ins-file').onclick = () => this.insertMediaFlow('file', insertAtCursor);

    const saveArticle = async (statusOverride) => {
      const visibility = document.querySelector('input[name="ed-vis"]:checked').value;
      const group_ids = [...document.querySelectorAll('.ed-group:checked')].map(c => Number(c.value));
      const status = statusOverride || document.getElementById('ed-status').value;
      const payload = {
        title: document.getElementById('ed-title').value,
        slug: document.getElementById('ed-slug').value,
        content_html: ed.getHtml(),
        category_id: document.getElementById('ed-cat').value || null,
        service_id: document.getElementById('ed-svc').value || null,
        status,
        visibility,
        group_ids,
        tags: document.getElementById('ed-tags').value.split(','),
        scheduled_at: document.getElementById('ed-sched').value,
        featured: document.getElementById('ed-feat').checked,
        pinned: document.getElementById('ed-pin').checked,
      };
      try {
        if (isNew) {
          const d = await api('/api/admin/articles', { method: 'POST', body: JSON.stringify(payload) });
          if (visibility === 'groups' && status === 'published') {
            const names = this.groups.filter(g => group_ids.includes(g.id)).map(g => g.name).join(', ');
            toast(`Published to group: ${names}`, 'ok');
          } else {
            toast(status === 'published' ? 'Article published' : 'Article saved as draft', 'ok');
          }
          location.hash = '#/admin/article/' + d.id;
        } else {
          await api('/api/admin/articles/' + id, { method: 'PUT', body: JSON.stringify(payload) });
          toast('Article saved — new version recorded', 'ok');
        }
      } catch (e) { toast(e.message, 'err'); }
    };
    document.getElementById('ed-save').onclick = () => saveArticle(isNew ? 'published' : undefined);
    const draftBtn = document.getElementById('ed-draft');
    if (draftBtn) draftBtn.onclick = () => saveArticle('draft');
  },

  /* ---------- versions ---------- */

  async versions(main, id) {
    const [a, vers] = await Promise.all([
      api('/api/admin/articles/' + id),
      api(`/api/admin/articles/${id}/versions`),
    ]);
    main.innerHTML = `
      <div class="crumbs"><a href="#/admin/articles">Articles</a> › <a href="#/admin/article/${id}">${esc(a.title)}</a> › History</div>
      <h2 style="margin-top:6px">Revision history</h2>
      <p style="color:var(--muted);font-size:.85rem">Every save creates a version. Compare any two, or roll back with one click.</p>
      <div id="ver-list">
        ${vers.map((v, i) => `
          <div class="ver-row">
            <input type="checkbox" class="ver-sel" value="${v.id}" ${i < 2 ? 'checked' : ''}>
            <div style="flex:1"><strong>v${v.version_number}</strong> <span style="color:var(--muted);font-size:.82rem">${esc(v.note || '')}</span><br>
            <small style="color:var(--muted2)">${esc(v.author_name || 'system')} · ${timeAgo(v.created_at)}</small></div>
            ${i === 0 ? '<span class="pill published">current</span>' : `<button class="btn ghost small" data-rb="${v.id}">Rollback to this</button>`}
          </div>`).join('') || '<div class="empty">No versions.</div>'}
      </div>
      <div style="margin:14px 0"><button class="btn ghost small" id="ver-diff">Compare selected</button></div>
      <div id="diff-out"></div>`;

    main.querySelectorAll('[data-rb]').forEach(b => b.onclick = async () => {
      if (!confirm('Roll back to this version? Current content becomes a new version first (nothing is lost).')) return;
      await api(`/api/admin/articles/${id}/rollback/${b.dataset.rb}`, { method: 'POST' });
      toast('Rolled back', 'ok');
      this.versions(main, id);
    });
    document.getElementById('ver-diff').onclick = () => {
      const sel = [...main.querySelectorAll('.ver-sel:checked')].map(c => c.value);
      if (sel.length !== 2) { toast('Select exactly two versions to compare', 'err'); return; }
      const [vA, vB] = sel.map(sid => vers.find(v => String(v.id) === sid));
      document.getElementById('diff-out').innerHTML = `<h3>Diff: v${vA.version_number} → v${vB.version_number}</h3>` + lineDiff(vA.content_html, vB.content_html);
    };
  },

  /* ---------- taxonomy managers ---------- */

  async taxManager(main, kind) {
    const title = kind === 'categories' ? 'Categories' : 'Services';
    const rows = kind === 'categories' ? this.tax.categories : this.tax.services;
    const isCat = kind === 'categories';
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">${title}</h2>
      <button class="btn small" id="tx-new">＋ New</button></div>
      ${isCat ? '<p style="color:var(--muted);font-size:.85rem">A <strong>staff-only</strong> category (and everything in it) is hidden from all readers.</p>' : ''}
      <div style="overflow-x:auto;margin-top:12px"><table class="tbl"><thead><tr><th></th><th>Name</th><th>Slug</th><th>Description</th>${isCat ? '<th>Visibility</th>' : ''}<th>Order</th><th></th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td>${isCat && (r.cover_image || r.icon_image) ? `<img src="${esc(r.cover_image || r.icon_image)}" style="width:52px;height:32px;object-fit:cover;border-radius:6px;vertical-align:middle">` : `<span style="background:${esc(r.color)}22;border-radius:8px;padding:4px 8px">${esc(r.icon)}</span>`}</td>
        <td><strong>${esc(r.name)}</strong></td><td style="color:var(--muted2)">/${esc(r.slug)}</td>
        <td style="color:var(--muted)">${esc(r.description || '')}</td>
        ${isCat ? `<td>${this.visPill(r.visibility === 'staff' ? 'staff' : 'all')}</td>` : ''}
        <td>${r.sort_order}</td>
        <td style="white-space:nowrap"><button class="link-btn" data-edit="${r.id}">Edit</button> · <button class="link-btn" data-del="${r.id}" style="color:var(--red)">Delete</button></td></tr>`).join('')}
      </tbody></table></div>
      <div id="tx-form"></div>`;

    const form = (r) => {
      document.getElementById('tx-form').innerHTML = `
        <div class="panel" style="margin-top:14px"><h3>${r ? 'Edit' : 'New'} ${isCat ? 'category' : 'service'}</h3>
        <div class="form-row">
          <label class="fld"><span>Name</span><input id="tx-name" value="${esc(r?.name || '')}"></label>
          <label class="fld"><span>Slug (auto if blank)</span><input id="tx-slug" value="${esc(r?.slug || '')}"></label>
        </div>
        <label class="fld"><span>Description</span><input id="tx-desc" value="${esc(r?.description || '')}"></label>
        <div class="form-row3">
          <label class="fld"><span>Icon (emoji)</span><input id="tx-icon" value="${esc(r?.icon || '📄')}" maxlength="8"></label>
          <label class="fld"><span>Color</span><input id="tx-color" type="color" value="${esc(r?.color || '#3B82F6')}" style="height:42px;padding:4px"></label>
          <label class="fld"><span>Sort order</span><input id="tx-order" type="number" value="${r?.sort_order ?? 0}"></label>
        </div>
        ${isCat ? `
        <label class="fld"><span>Cover image <small style="color:var(--muted)">(BookStack-style book cover — becomes the category's lead visual on cards and listings; the emoji icon is only a fallback when no cover is set)</small></span>
          <span style="display:flex;gap:8px;align-items:center">
            <input id="tx-coverimg" value="${esc(r?.cover_image || r?.icon_image || '')}" placeholder="/media/…" style="flex:1">
            <span id="tx-coverprev">${(r?.cover_image || r?.icon_image) ? `<img src="${esc(r.cover_image || r.icon_image)}" style="width:52px;height:32px;object-fit:cover;border-radius:6px">` : ''}</span>
            <label class="btn ghost small" style="cursor:pointer">Upload<input type="file" id="tx-coverfile" accept="image/*" style="display:none"></label>
            <button class="btn ghost small" type="button" id="tx-coverpick">Library…</button>
            <button class="btn ghost small" type="button" id="tx-coverclear">Clear</button>
          </span></label>` : ''}
        ${isCat ? `
        <div class="form-row3">
          <label class="fld"><span>Parent</span><select id="tx-parent"><option value="">None</option>${this.tax.categories.filter(c => !r || c.id !== r.id).map(c => `<option value="${c.id}" ${r?.parent_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="fld"><span>Visibility</span><select id="tx-vis">
            <option value="all" ${(r?.visibility || 'all') === 'all' ? 'selected' : ''}>🌍 Everyone</option>
            <option value="staff" ${r?.visibility === 'staff' ? 'selected' : ''}>🔒 Staff only</option>
          </select></label>
        </div>` : ''}
        <div style="display:flex;gap:8px"><button class="btn small" id="tx-save">Save</button><button class="btn ghost small" id="tx-cancel">Cancel</button></div>
        </div>`;
      document.getElementById('tx-cancel').onclick = () => this.taxManager(main, kind);
      if (isCat) {
        const coverInput = document.getElementById('tx-coverimg');
        const coverPrev = document.getElementById('tx-coverprev');
        const setCover = (url) => { coverInput.value = url || ''; coverPrev.innerHTML = url ? `<img src="${esc(url)}" style="width:52px;height:32px;object-fit:cover;border-radius:6px">` : ''; };
        coverInput.addEventListener('input', () => setCover(coverInput.value));
        document.getElementById('tx-coverclear').onclick = () => setCover('');
        document.getElementById('tx-coverpick').onclick = () => this.openMediaPicker({ kind: 'image', title: 'Choose category cover', cb: (f) => setCover(f.url) });
        document.getElementById('tx-coverfile').onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try { const [up] = await this.uploadFiles([f]); setCover(up.url); toast('Cover uploaded', 'ok'); }
          catch (err) { toast(err.message, 'err'); }
        };
      }
      document.getElementById('tx-save').onclick = async () => {
        const payload = {
          name: document.getElementById('tx-name').value,
          slug: document.getElementById('tx-slug').value,
          description: document.getElementById('tx-desc').value,
          icon: document.getElementById('tx-icon').value,
          color: document.getElementById('tx-color').value,
          sort_order: Number(document.getElementById('tx-order').value) || 0,
        };
        if (isCat) {
          payload.cover_image = document.getElementById('tx-coverimg').value.trim();
          payload.icon_image = '';
          const p = document.getElementById('tx-parent');
          payload.parent_id = p && p.value ? Number(p.value) : null;
          payload.visibility = document.getElementById('tx-vis').value === 'staff' ? 'staff' : 'all';
        }
        try {
          if (r) await api(`/api/admin/${kind}/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) });
          else await api(`/api/admin/${kind}`, { method: 'POST', body: JSON.stringify(payload) });
          toast('Saved', 'ok'); await this.loadTax(); this.taxManager(main, kind);
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    document.getElementById('tx-new').onclick = () => form(null);
    main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(rows.find(r => String(r.id) === b.dataset.edit)));
    main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this? Articles using it will keep working but lose the grouping.')) return;
      await api(`/api/admin/${kind}/${b.dataset.del}`, { method: 'DELETE' });
      toast('Deleted', 'ok'); await this.loadTax(); this.taxManager(main, kind);
    });
  },

  async tagsManager(main) {
    const tags = await api('/api/admin/tags');
    main.innerHTML = `<h2 style="margin-top:0">Tags</h2>
      <p style="color:var(--muted);font-size:.85rem">Tags are created automatically when you add them to articles. You can remove unused ones here.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${tags.map(t => `<span class="tag" style="font-size:.85rem;padding:6px 12px">${esc(t.name)} <button class="link-btn" data-tagdel="${t.id}" style="color:var(--red)">✕</button></span>`).join('') || '<div class="empty">No tags yet.</div>'}
      </div>`;
    main.querySelectorAll('[data-tagdel]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this tag?')) return;
      await api('/api/admin/tags/' + b.dataset.tagdel, { method: 'DELETE' });
      toast('Tag deleted', 'ok'); this.tagsManager(main);
    });
  },

  /* ---------- media library ---------- */

  async media(main) {
    const state = { files: [], q: '', kind: '', sort: 'newest', view: 'grid', selected: new Set() };
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">Media Library</h2>
        <span style="color:var(--muted);font-size:.82rem" id="med-count"></span>
      </div>
      <div class="panel" style="margin:12px 0">
        <div id="med-drop" class="drop-zone">
          <strong>Drop files here</strong> or
          <label class="btn small" style="cursor:pointer;margin-left:6px">Choose files<input type="file" id="med-files" multiple style="display:none"></label>
          <div style="font-size:.78rem;color:var(--muted);margin-top:6px">Images, videos, audio, PDFs, text, logs, zips — up to 15 MB each. Files are hosted on this instance.</div>
          <div id="med-up-status" style="font-size:.8rem;margin-top:6px"></div>
        </div>
      </div>
      <div class="toolbar">
        <input type="text" id="med-q" placeholder="Search name/title…" style="max-width:220px">
        <select id="med-kind" style="max-width:150px">
          <option value="">All types</option><option value="image">🖼 Images</option><option value="video">🎬 Videos</option>
          <option value="audio">🎵 Audio</option><option value="file">📎 Files</option>
        </select>
        <select id="med-sort" style="max-width:150px">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option><option value="size">Largest first</option>
        </select>
        <button class="btn ghost small" id="med-view">${'▦ Grid'}</button>
        <span id="med-bulk" style="display:none;gap:8px;align-items:center">
          <span id="med-selcount" style="font-size:.82rem;color:var(--muted)"></span>
          <button class="btn danger small" id="med-bulkdel">Delete selected</button>
        </span>
      </div>
      <div id="med-body"></div>`;

    const body = document.getElementById('med-body');
    const kindIcon = (f) => f.kind === 'image' ? '🖼' : f.kind === 'video' ? '🎬' : f.kind === 'audio' ? '🎵' : '📎';
    const thumb = (f, h) => f.kind === 'image'
      ? `<img src="${f.url}" style="width:100%;height:${h}px;object-fit:cover;border-radius:8px">`
      : f.kind === 'video'
        ? `<video src="${f.url}" preload="metadata" style="width:100%;height:${h}px;object-fit:cover;border-radius:8px;background:#000"></video>`
        : `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;font-size:2rem">${kindIcon(f)}</div>`;

    const render = () => {
      let files = state.files.slice();
      if (state.kind) files = files.filter(f => f.kind === state.kind);
      if (state.q) files = files.filter(f => (f.original_name + ' ' + (f.title || '')).toLowerCase().includes(state.q));
      if (!state.kind && !state.q) files = state.files.slice(); // server already sorted
      document.getElementById('med-count').textContent = `${files.length} file(s) · ${(files.reduce((s, f) => s + f.size_bytes, 0) / 1024).toFixed(0)} KB total`;
      const bulk = document.getElementById('med-bulk');
      bulk.style.display = state.selected.size ? 'inline-flex' : 'none';
      document.getElementById('med-selcount').textContent = `${state.selected.size} selected`;
      if (!files.length) { body.innerHTML = '<div class="empty">No files match.</div>'; return; }
      if (state.view === 'grid') {
        body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px">${files.map(f => `
          <div class="panel" style="padding:10px">
            <div style="display:flex;gap:6px;align-items:flex-start">${thumb(f, 92)}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <input type="checkbox" class="med-sel" data-id="${f.id}" ${state.selected.has(f.id) ? 'checked' : ''} style="width:auto">
              <span class="pill" style="background:var(--input)">${kindIcon(f)} ${esc(f.kind)}</span>
              <span style="font-size:.7rem;color:var(--muted2)">${(f.size_bytes / 1024).toFixed(0)} KB</span>
            </div>
            <div style="font-size:.76rem;margin-top:4px;word-break:break-all;font-weight:600">${esc(f.title || f.original_name)}</div>
            ${f.article_title ? `<div style="font-size:.7rem;color:var(--muted)">on: ${esc(f.article_title)}</div>` : ''}
            <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
              <button class="btn ghost small" data-copy="${f.url}">Copy URL</button>
              <button class="btn ghost small" data-fedit="${f.id}">Edit</button>
              <button class="btn ghost small" data-fdel="${f.id}" style="color:var(--red)">Delete</button>
            </div>
          </div>`).join('')}</div>`;
      } else {
        body.innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th></th><th></th><th>Name</th><th>Type</th><th>Size</th><th>Attached to</th><th>Uploaded</th><th></th></tr></thead><tbody>
          ${files.map(f => `<tr>
            <td><input type="checkbox" class="med-sel" data-id="${f.id}" ${state.selected.has(f.id) ? 'checked' : ''}></td>
            <td style="width:64px">${thumb(f, 40)}</td>
            <td><strong>${esc(f.title || f.original_name)}</strong><br><small style="color:var(--muted2)">${esc(f.original_name)}</small></td>
            <td>${kindIcon(f)} ${esc(f.kind)}</td><td>${(f.size_bytes / 1024).toFixed(0)} KB</td>
            <td>${f.article_title ? esc(f.article_title) : '<span style="color:var(--muted2)">—</span>'}</td>
            <td style="white-space:nowrap">${timeAgo(f.uploaded_at)}</td>
            <td style="white-space:nowrap"><button class="link-btn" data-copy="${f.url}">Copy URL</button> · <button class="link-btn" data-fedit="${f.id}">Edit</button> · <button class="link-btn" data-fdel="${f.id}" style="color:var(--red)">Delete</button></td>
          </tr>`).join('')}</tbody></table></div>`;
      }
      body.querySelectorAll('.med-sel').forEach(c => c.onchange = () => {
        const id = Number(c.dataset.id);
        if (c.checked) state.selected.add(id); else state.selected.delete(id);
        render();
      });
      body.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
        await navigator.clipboard.writeText(location.origin + b.dataset.copy).catch(() => {});
        toast('Hosted URL copied', 'ok');
      });
      body.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this file? Articles embedding it will lose the media.')) return;
        await api('/api/admin/attachments/' + b.dataset.fdel, { method: 'DELETE' });
        state.selected.delete(Number(b.dataset.fdel));
        toast('Deleted', 'ok'); load();
      });
      body.querySelectorAll('[data-fedit]').forEach(b => b.onclick = () => this.mediaEdit(state.files.find(f => String(f.id) === b.dataset.fedit), load));
    };

    const load = async () => {
      const q = new URLSearchParams();
      if (state.kind) q.set('kind', state.kind);
      q.set('sort', state.sort);
      state.files = await api('/api/admin/attachments?' + q.toString());
      render();
    };

    const doUpload = async (fileList) => {
      const files = [...fileList];
      if (!files.length) return;
      const st = document.getElementById('med-up-status');
      st.textContent = `Uploading ${files.length} file(s)…`;
      try {
        const up = await this.uploadFiles(files);
        st.textContent = `✅ Uploaded ${up.length} file(s).`;
        toast(`Uploaded ${up.length} file(s)`, 'ok');
        load();
      } catch (e) { st.textContent = '❌ ' + e.message; toast(e.message, 'err'); }
    };

    const drop = document.getElementById('med-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload(e.dataTransfer.files); });
    document.getElementById('med-files').onchange = (e) => doUpload(e.target.files);
    document.getElementById('med-q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
    document.getElementById('med-kind').onchange = (e) => { state.kind = e.target.value; load(); };
    document.getElementById('med-sort').onchange = (e) => { state.sort = e.target.value; load(); };
    document.getElementById('med-view').onclick = (e) => {
      state.view = state.view === 'grid' ? 'list' : 'grid';
      e.target.textContent = state.view === 'grid' ? '▦ Grid' : '☰ List';
      render();
    };
    document.getElementById('med-bulkdel').onclick = async () => {
      const ids = [...state.selected];
      if (!ids.length || !confirm(`Delete ${ids.length} file(s)?`)) return;
      const r = await api('/api/admin/attachments/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
      state.selected.clear();
      toast(`Deleted ${r.deleted} file(s)`, 'ok'); load();
    };
    await load();
  },

  mediaEdit(f, reload) {
    if (!f) return;
    api('/api/admin/articles').then(articles => {
      openModal(`<div style="padding:20px;max-width:520px">
        <h3 style="margin-top:0">Edit media</h3>
        ${f.kind === 'image' ? `<img src="${f.url}" style="width:100%;max-height:180px;object-fit:contain;border-radius:8px;background:var(--input)">` : ''}
        <p style="font-size:.78rem;color:var(--muted);word-break:break-all">${esc(f.original_name)} · ${esc(f.mime_type)} · ${(f.size_bytes / 1024).toFixed(0)} KB<br>Hosted URL: <code>${esc(f.url)}</code></p>
        <label class="fld"><span>Title</span><input id="fm-title" value="${esc(f.title || '')}"></label>
        <label class="fld"><span>Alt text (images)</span><input id="fm-alt" value="${esc(f.alt_text || '')}"></label>
        <label class="fld"><span>Caption</span><input id="fm-cap" value="${esc(f.caption || '')}"></label>
        <label class="fld"><span>Attach to article</span><select id="fm-art"><option value="">— not attached —</option>
          ${articles.map(a => `<option value="${a.id}" ${f.article_id === a.id ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></label>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn small" id="fm-save">Save</button><button class="btn ghost small" id="fm-cancel">Cancel</button></div>
      </div>`);
      document.getElementById('fm-cancel').onclick = closeModal;
      document.getElementById('fm-save').onclick = async () => {
        try {
          await api('/api/admin/attachments/' + f.id, { method: 'PUT', body: JSON.stringify({
            title: document.getElementById('fm-title').value,
            alt_text: document.getElementById('fm-alt').value,
            caption: document.getElementById('fm-cap').value,
            article_id: document.getElementById('fm-art').value || null,
          }) });
          closeModal(); toast('Media updated', 'ok'); reload();
        } catch (e) { toast(e.message, 'err'); }
      };
    }).catch(e => toast(e.message, 'err'));
  },

  /* ---------- redirects ---------- */

  async redirects(main) {
    const rows = await api('/api/admin/redirects');
    main.innerHTML = `<h2 style="margin-top:0">Redirects</h2>
      <p style="color:var(--muted);font-size:.85rem">Old slugs automatically redirect when you rename an article. Add manual ones here.</p>
      <div class="toolbar"><input type="text" id="rd-from" placeholder="old-slug" style="max-width:200px"><span>→</span>
      <input type="text" id="rd-to" placeholder="new-slug" style="max-width:200px">
      <button class="btn small" id="rd-add">Add redirect</button></div>
      <table class="tbl"><thead><tr><th>From</th><th>To</th><th>Created</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><code>/${esc(r.from_slug)}</code></td><td><code>/${esc(r.to_slug)}</code></td><td>${timeAgo(r.created_at)}</td>
      <td><button class="link-btn" data-rdel="${r.id}" style="color:var(--red)">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No redirects.</td></tr>'}
      </tbody></table>`;
    document.getElementById('rd-add').onclick = async () => {
      try {
        await api('/api/admin/redirects', { method: 'POST', body: JSON.stringify({ from_slug: document.getElementById('rd-from').value, to_slug: document.getElementById('rd-to').value }) });
        toast('Redirect added', 'ok'); this.redirects(main);
      } catch (e) { toast(e.message, 'err'); }
    };
    main.querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => {
      await api('/api/admin/redirects/' + b.dataset.rdel, { method: 'DELETE' });
      this.redirects(main);
    });
  },

  /* ---------- feedback inbox ---------- */

  async feedback(main) {
    const rows = await api('/api/admin/feedback');
    main.innerHTML = `<h2 style="margin-top:0">Feedback Inbox</h2>
      <p style="color:var(--muted);font-size:.85rem">“Was this helpful?” votes per article, sorted by unhelpful rate. Fix the top ones first.</p>
      <table class="tbl"><thead><tr><th>Article</th><th>👍</th><th>👎</th><th>Helpful %</th><th></th></tr></thead><tbody>
      ${rows.map(r => {
        const total = r.helpful_yes + r.helpful_no;
        const pct = total ? Math.round(r.helpful_yes / total * 100) : 100;
        return `<tr><td><a href="#/article/${esc(r.slug)}" style="color:var(--text);font-weight:600">${esc(r.title)}</a></td>
        <td>${r.helpful_yes}</td><td>${r.helpful_no}</td>
        <td><div class="progress" style="width:120px"><div style="width:${pct}%;background:${pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)'}"></div></div> ${pct}%</td>
        <td><a class="link-btn" href="#/admin/article/${r.id}">Edit</a></td></tr>`;
      }).join('') || '<tr><td colspan="5" class="empty">No feedback yet.</td></tr>'}
      </tbody></table>`;
  },

  /* ---------- search analytics ---------- */

  async searchAnalytics(main) {
    const d = await api('/api/admin/search-analytics');
    main.innerHTML = `<h2 style="margin-top:0">Search Analytics</h2>
      <div class="two-col">
        <div class="panel"><h3>Top queries (30 days)</h3><div class="art-list">
          ${d.top.map(t => `<div class="art-row"><div class="t" style="font-size:.86rem;font-weight:600">${esc(t.query)}</div><div class="meta">${t.searches} searches · avg ${Number(t.avg_results).toFixed(1)} results · ${timeAgo(t.last_searched)}</div></div>`).join('') || '<div class="empty">No searches yet.</div>'}
        </div></div>
        <div class="panel"><h3>⚠️ No-result queries</h3><p style="color:var(--muted);font-size:.8rem">Write articles for these — readers are asking and finding nothing.</p><div class="art-list">
          ${d.no_result.map(t => `<div class="art-row"><div class="t" style="font-size:.86rem;font-weight:600">${esc(t.query)}</div><div class="meta">${t.searches} searches · ${timeAgo(t.last_searched)}</div></div>`).join('') || '<div class="empty">None — every search found something. 🎉</div>'}
        </div></div>
      </div>`;
  },

  /* ---------- customers ---------- */

  async customers(main) {
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">Customers</h2>
        <div style="display:flex;gap:8px">
          <button class="btn ghost small" id="c-import">⬆ CSV import</button>
          <button class="btn small" id="c-new">＋ Add customer</button>
        </div>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <input type="text" id="c-q" placeholder="Search name/email/company…" style="max-width:240px">
        <select id="c-group" style="max-width:180px"><option value="">All groups</option>${this.groups.map(g => `<option value="${g.id}">${esc(g.name)} (${g.customer_count})</option>`).join('')}<option value="none">No group</option></select>
        <select id="c-status" style="max-width:140px"><option value="">All statuses</option><option value="0">Active</option><option value="1">Disabled</option></select>
        <button class="btn ghost small" id="c-go">Filter</button>
      </div>
      <div class="toolbar" id="c-bulkbar" style="display:none">
        <span id="c-bulkcount" style="font-size:.85rem;color:var(--muted)"></span>
        <select id="c-bulkgroup" style="max-width:180px"><option value="">Remove from group</option>${this.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
        <button class="btn ghost small" id="c-bulkgo">Assign group</button>
      </div>
      <div style="overflow-x:auto"><table class="tbl"><thead><tr>
        <th><input type="checkbox" id="c-selall"></th><th>Name</th><th>Email</th><th>Group</th><th>Status</th><th>Last login</th><th></th>
      </tr></thead><tbody id="c-rows"></tbody></table></div>
      <div id="c-form"></div>`;

    const load = async () => {
      const q = new URLSearchParams();
      const v = id => document.getElementById(id).value;
      if (v('c-q')) q.set('q', v('c-q'));
      if (v('c-group')) q.set('group_id', v('c-group') === 'none' ? '0' : v('c-group'));
      if (v('c-status')) q.set('disabled', v('c-status'));
      let rows = await api('/api/admin/customers?' + q.toString());
      if (v('c-group') === 'none') rows = rows.filter(r => !r.group_id);
      const tb = document.getElementById('c-rows');
      tb.innerHTML = rows.map(c => `
        <tr>
          <td><input type="checkbox" class="c-sel" value="${c.id}"></td>
          <td><strong>${esc(c.name)}</strong>${c.company ? `<br><small style="color:var(--muted2)">${esc(c.company)}</small>` : ''}</td>
          <td style="color:var(--muted)">${esc(c.email)}</td>
          <td>${c.group_name ? `<span class="pill" style="background:${esc(c.group_color || '#8B5CF6')}22;color:${esc(c.group_color || '#8B5CF6')}">${esc(c.group_name)}</span>` : '<span style="color:var(--muted2)">—</span>'}</td>
          <td>${c.disabled ? '<span class="pill archived">disabled</span>' : '<span class="pill published">active</span>'}</td>
          <td style="white-space:nowrap">${c.last_login_at ? timeAgo(c.last_login_at) : '<span style="color:var(--muted2)">never</span>'}</td>
          <td style="white-space:nowrap"><button class="link-btn" data-cedit="${c.id}">Edit</button> ·
          <button class="link-btn" data-cdis="${c.id}">${c.disabled ? 'Enable' : 'Disable'}</button> ·
          <button class="link-btn" data-cdel="${c.id}" style="color:var(--red)">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">No customers.</td></tr>';
      tb.querySelectorAll('[data-cedit]').forEach(b => b.onclick = () => this.customerForm(main, rows.find(r => String(r.id) === b.dataset.cedit), load));
      tb.querySelectorAll('[data-cdis]').forEach(b => b.onclick = async () => {
        const row = rows.find(r => String(r.id) === b.dataset.cdis);
        await api('/api/admin/customers/' + b.dataset.cdis, { method: 'PUT', body: JSON.stringify({ disabled: !row.disabled }) });
        toast(row.disabled ? 'Customer enabled' : 'Customer disabled', 'ok'); load();
      });
      tb.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this customer permanently? Their login stops working immediately.')) return;
        await api('/api/admin/customers/' + b.dataset.cdel, { method: 'DELETE' });
        toast('Customer deleted', 'ok'); load();
      });
      const upd = () => {
        const n = tb.querySelectorAll('.c-sel:checked').length;
        document.getElementById('c-bulkbar').style.display = n ? 'flex' : 'none';
        document.getElementById('c-bulkcount').textContent = `${n} selected`;
      };
      tb.querySelectorAll('.c-sel').forEach(c => c.onchange = upd);
      document.getElementById('c-selall').onchange = (e) => { tb.querySelectorAll('.c-sel').forEach(c => c.checked = e.target.checked); upd(); };
    };

    document.getElementById('c-go').onclick = load;
    document.getElementById('c-q').onkeydown = (e) => { if (e.key === 'Enter') load(); };
    document.getElementById('c-new').onclick = () => this.customerForm(main, null, load);
    document.getElementById('c-import').onclick = () => this.customerImport(main, load);
    document.getElementById('c-bulkgo').onclick = async () => {
      const ids = [...document.querySelectorAll('.c-sel:checked')].map(c => Number(c.value));
      if (!ids.length) return;
      const group_id = document.getElementById('c-bulkgroup').value || null;
      const r = await api('/api/admin/customers/bulk-assign', { method: 'POST', body: JSON.stringify({ ids, group_id }) });
      toast(`${r.affected} customer(s) assigned`, 'ok'); load();
    };
    await load();
  },

  customerForm(main, c, reload) {
    const box = document.getElementById('c-form');
    box.innerHTML = `
      <div class="panel" style="margin-top:14px"><h3>${c ? 'Edit customer' : 'Add customer'}</h3>
      <div class="form-row">
        <label class="fld"><span>Full name *</span><input id="cf-name" value="${esc(c?.name || '')}"></label>
        <label class="fld"><span>Email *</span><input id="cf-email" type="email" value="${esc(c?.email || '')}"></label>
      </div>
      <div class="form-row3">
        <label class="fld"><span>Company</span><input id="cf-company" value="${esc(c?.company || '')}"></label>
        <label class="fld"><span>Phone</span><input id="cf-phone" value="${esc(c?.phone || '')}"></label>
        <label class="fld"><span>Group</span><select id="cf-group"><option value="">No group</option>${this.groups.map(g => `<option value="${g.id}" ${c?.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      </div>
      <label class="fld"><span>Notes (staff only)</span><textarea id="cf-notes" rows="2">${esc(c?.notes || '')}</textarea></label>
      <label class="fld"><span>${c ? 'Reset password (blank = keep current)' : 'Password (blank = auto-generated, shown once)'}</span><input id="cf-pass" type="text" placeholder="${c ? '—' : 'auto-generate'}"></label>
      <div id="cf-pwout"></div>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn small" id="cf-save">Save</button><button class="btn ghost small" id="cf-cancel">Cancel</button></div>
      </div>`;
    document.getElementById('cf-cancel').onclick = () => { box.innerHTML = ''; };
    document.getElementById('cf-save').onclick = async () => {
      const payload = {
        name: document.getElementById('cf-name').value,
        email: document.getElementById('cf-email').value,
        company: document.getElementById('cf-company').value,
        phone: document.getElementById('cf-phone').value,
        notes: document.getElementById('cf-notes').value,
        group_id: document.getElementById('cf-group').value || null,
      };
      const pw = document.getElementById('cf-pass').value;
      if (pw) payload.password = pw;
      try {
        if (c) {
          const r = await api('/api/admin/customers/' + c.id, { method: 'PUT', body: JSON.stringify(payload) });
          if (r.temp_password) document.getElementById('cf-pwout').innerHTML = `<p class="pw-once">🔑 New password (copy now — shown once): <code>${esc(r.temp_password)}</code></p>`;
          else { toast('Saved', 'ok'); box.innerHTML = ''; reload(); }
        } else {
          const r = await api('/api/admin/customers', { method: 'POST', body: JSON.stringify(payload) });
          document.getElementById('cf-pwout').innerHTML = `<p class="pw-once">🔑 Login password (copy now — shown once): <code>${esc(r.temp_password)}</code></p>
            <div style="display:flex;gap:8px"><button class="btn small" id="cf-done">Done</button></div>`;
          document.getElementById('cf-done').onclick = () => { box.innerHTML = ''; reload(); };
        }
        toast('Saved', 'ok'); reload();
      } catch (e) { toast(e.message, 'err'); }
    };
  },

  /* CSV import with column-mapping preview step. */
  customerImport(main, reload) {
    openModal(`<div style="padding:20px;max-width:720px">
      <h3 style="margin-top:0">⬆ Import customers from CSV</h3>
      <div id="ci-step1">
        <label class="fld"><span>Paste CSV or choose a file</span>
          <textarea id="ci-csv" rows="6" placeholder="name,email,company,phone&#10;Priya Sharma,priya@example.com,Sharma Media Co.,555-0100"></textarea></label>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <label class="btn ghost small" style="cursor:pointer">Choose file<input type="file" id="ci-file" accept=".csv,text/csv" style="display:none"></label>
          <label class="check-row" style="margin:0"><input type="checkbox" id="ci-header" checked> First row is a header</label>
          <button class="btn small" id="ci-next">Next: map columns →</button>
        </div>
      </div>
      <div id="ci-step2" style="display:none"></div>
      <div id="ci-step3" style="display:none"></div>
    </div>`);
    document.getElementById('ci-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) document.getElementById('ci-csv').value = await f.text();
    };
    const parseLocal = (text) => {
      const rows = [];
      let row = [], field = '', q = false;
      const s = String(text || '').replace(/^\uFEFF/, '');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) { if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch !== '\r') field += ch;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
    };
    document.getElementById('ci-next').onclick = () => {
      const text = document.getElementById('ci-csv').value;
      const rows = parseLocal(text);
      if (!rows.length) { toast('No rows found', 'err'); return; }
      const hasHeader = document.getElementById('ci-header').checked;
      const header = hasHeader ? rows[0] : rows[0].map((_, i) => 'Column ' + (i + 1));
      const dataRows = hasHeader ? rows.slice(1) : rows;
      const nCols = Math.max(...rows.map(r => r.length));
      const fields = [['name', 'Full name *'], ['email', 'Email *'], ['company', 'Company'], ['phone', 'Phone'], ['notes', 'Notes']];
      // auto-guess mapping from header names
      const guess = {};
      header.forEach((h, i) => {
        const hl = h.toLowerCase();
        for (const [key] of fields) if (hl.includes(key) || (key === 'name' && /^(name|full)/.test(hl))) { if (guess[key] === undefined) guess[key] = i; }
      });
      if (guess.name === undefined) guess.name = 0;
      if (guess.email === undefined && nCols > 1) guess.email = 1;
      const colOpts = (sel) => header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h)} (col ${i + 1})</option>`).join('');
      document.getElementById('ci-step1').style.display = 'none';
      const s2 = document.getElementById('ci-step2');
      s2.style.display = '';
      s2.innerHTML = `
        <p style="color:var(--muted);font-size:.85rem">${dataRows.length} data row(s) found. Map each CSV column to a customer field, then preview.</p>
        <div class="form-row">${fields.map(([key, label]) => `
          <label class="fld"><span>${label}</span><select data-map="${key}"><option value="-1">— ignore —</option>${colOpts(guess[key])}</select></label>`).join('')}
        </div>
        <div class="form-row3">
          <label class="fld"><span>Add to group</span><select id="ci-group"><option value="">No group</option>${this.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
          <label class="fld"><span>Default password (blank = auto)</span><input id="ci-pass" type="text" placeholder="auto-generate"></label>
        </div>
        <h4>Preview (first 5 rows)</h4>
        <div style="overflow-x:auto"><table class="tbl"><thead><tr>${fields.map(([k, l]) => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody id="ci-prev"></tbody></table></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn ghost small" id="ci-back">← Back</button>
          <button class="btn small" id="ci-import">Import ${dataRows.length} row(s)</button>
        </div>`;
      const renderPreview = () => {
        const m = {};
        s2.querySelectorAll('[data-map]').forEach(sel => m[sel.dataset.map] = Number(sel.value));
        document.getElementById('ci-prev').innerHTML = dataRows.slice(0, 5).map(r =>
          `<tr>${fields.map(([k]) => `<td>${esc(m[k] >= 0 ? (r[m[k]] || '') : '')}</td>`).join('')}</tr>`).join('');
      };
      s2.querySelectorAll('[data-map]').forEach(sel => sel.onchange = renderPreview);
      renderPreview();
      document.getElementById('ci-back').onclick = () => { s2.style.display = 'none'; document.getElementById('ci-step1').style.display = ''; };
      document.getElementById('ci-import').onclick = async () => {
        const mapping = {};
        s2.querySelectorAll('[data-map]').forEach(sel => mapping[sel.dataset.map] = Number(sel.value));
        try {
          const r = await api('/api/admin/customers/import', {
            method: 'POST',
            body: JSON.stringify({
              csv: text,
              mapping,
              group_id: document.getElementById('ci-group').value || null,
              default_password: document.getElementById('ci-pass').value || undefined,
              skip_header: !hasHeader,
            }),
          });
          const s3 = document.getElementById('ci-step3');
          s2.style.display = 'none'; s3.style.display = '';
          s3.innerHTML = `
            <h4>✅ Imported ${r.imported} customer(s)</h4>
            ${r.default_password ? `<p class="pw-once">🔑 Default password for imported customers (copy now): <code>${esc(r.default_password)}</code></p>` : ''}
            ${r.errors.length ? `<h4 style="color:var(--red)">⚠️ ${r.errors.length} row(s) skipped</h4>
              <div style="max-height:180px;overflow:auto"><table class="tbl"><thead><tr><th>Row</th><th>Error</th></tr></thead>
              <tbody>${r.errors.map(e => `<tr><td>${e.row}</td><td>${esc(e.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}
            <div style="margin-top:12px"><button class="btn small" id="ci-done">Done</button></div>`;
          document.getElementById('ci-done').onclick = () => { closeModal(); reload(); };
        } catch (e) { toast(e.message, 'err'); }
      };
    };
  },

  /* ---------- customer groups ---------- */

  async groupsManager(main) {
    const rows = this.groups;
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Customer Groups</h2>
      <button class="btn small" id="g-new">＋ New group</button></div>
      <p style="color:var(--muted);font-size:.85rem">Group articles by audience: set an article's visibility to “Customer groups” and pick which groups may read it.</p>
      <div style="overflow-x:auto;margin-top:12px"><table class="tbl"><thead><tr><th></th><th>Name</th><th>Slug</th><th>Customers</th><th>Description</th><th></th></tr></thead>
      <tbody>${rows.map(g => `
        <tr><td><span style="background:${esc(g.color)}22;color:${esc(g.color)};border-radius:8px;padding:4px 10px;font-weight:700">${esc(g.name.slice(0, 2).toUpperCase())}</span></td>
        <td><strong>${esc(g.name)}</strong></td><td style="color:var(--muted2)">/${esc(g.slug)}</td>
        <td>${g.customer_count}</td><td style="color:var(--muted)">${esc(g.description || '')}</td>
        <td style="white-space:nowrap"><button class="link-btn" data-gedit="${g.id}">Edit</button> · <button class="link-btn" data-gdel="${g.id}" style="color:var(--red)">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No groups yet.</td></tr>'}
      </tbody></table></div><div id="g-form"></div>`;

    const form = (g) => {
      document.getElementById('g-form').innerHTML = `
        <div class="panel" style="margin-top:14px"><h3>${g ? 'Edit' : 'New'} group</h3>
        <div class="form-row">
          <label class="fld"><span>Name</span><input id="g-name" value="${esc(g?.name || '')}"></label>
          <label class="fld"><span>Slug (auto if blank)</span><input id="g-slug" value="${esc(g?.slug || '')}"></label>
        </div>
        <div class="form-row3">
          <label class="fld"><span>Color</span><input id="g-color" type="color" value="${esc(g?.color || '#8B5CF6')}" style="height:42px;padding:4px"></label>
        </div>
        <label class="fld"><span>Description</span><input id="g-desc" value="${esc(g?.description || '')}"></label>
        <div style="display:flex;gap:8px"><button class="btn small" id="g-save">Save</button><button class="btn ghost small" id="g-cancel">Cancel</button></div></div>`;
      document.getElementById('g-cancel').onclick = () => this.groupsManager(main);
      document.getElementById('g-save').onclick = async () => {
        const payload = {
          name: document.getElementById('g-name').value,
          slug: document.getElementById('g-slug').value,
          color: document.getElementById('g-color').value,
          description: document.getElementById('g-desc').value,
        };
        try {
          if (g) await api('/api/admin/groups/' + g.id, { method: 'PUT', body: JSON.stringify(payload) });
          else await api('/api/admin/groups', { method: 'POST', body: JSON.stringify(payload) });
          toast('Saved', 'ok');
          this.groups = await api('/api/admin/groups');
          this.groupsManager(main);
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    document.getElementById('g-new').onclick = () => form(null);
    main.querySelectorAll('[data-gedit]').forEach(b => b.onclick = () => form(rows.find(r => String(r.id) === b.dataset.gedit)));
    main.querySelectorAll('[data-gdel]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this group? Customers in it become ungrouped.')) return;
      try {
        await api('/api/admin/groups/' + b.dataset.gdel, { method: 'DELETE' });
        toast('Deleted', 'ok');
        this.groups = await api('/api/admin/groups');
        this.groupsManager(main);
      } catch (e) { toast(e.message, 'err'); }
    });
  },

  /* ---------- site & branding ---------- */

  async branding(main) {
    const s = await api('/api/admin/settings');
    const colorRow = (id, label, val) => `
      <label class="fld"><span>${label}</span>
        <span style="display:flex;gap:8px;align-items:center"><input type="color" id="${id}" value="${esc(val || '#000000')}" style="height:42px;padding:4px;flex:0 0 60px"><input type="text" id="${id}-txt" value="${esc(val || '')}" style="flex:1"></span>
      </label>`;
    main.innerHTML = `<h2 style="margin-top:0">🎨 Site & Branding</h2>
      <div class="two-col">
        <div>
          <div class="panel"><h3>Identity</h3>
            <div class="form-row">
              <label class="fld"><span>Site title</span><input id="b-title" value="${esc(s.site_title)}"></label>
              <label class="fld"><span>Tagline</span><input id="b-tagline" value="${esc(s.site_tagline)}"></label>
            </div>
            <div class="form-row">
              <label class="fld"><span>Logo text (shown when no logo image)</span><input id="b-logo" value="${esc(s.logo_text)}"></label>
              <label class="fld"><span>Default theme</span><select id="b-theme">
                <option value="dark" ${s.default_theme === 'dark' ? 'selected' : ''}>Dark</option>
                <option value="light" ${s.default_theme === 'light' ? 'selected' : ''}>Light</option>
              </select></label>
            </div>
            <div class="form-row">
              <label class="fld"><span>Logo image URL</span>
                <span style="display:flex;gap:8px"><input id="b-logourl" value="${esc(s.logo_url)}" placeholder="/media/…" style="flex:1">
                <label class="btn ghost small" style="cursor:pointer">Upload<input type="file" id="b-logo-file" accept="image/*" style="display:none"></label>
                <button class="btn ghost small" type="button" id="b-logo-pick">Library…</button></span></label>
              <label class="fld"><span>Favicon (URL or upload an image)</span>
                <span style="display:flex;gap:8px;align-items:center"><input id="b-fav" value="${esc(s.favicon_url)}" placeholder="/media/…" style="flex:1">
                <span id="b-fav-prev">${s.favicon_url ? `<img src="${esc(s.favicon_url)}" style="width:20px;height:20px;object-fit:contain">` : ''}</span>
                <label class="btn ghost small" style="cursor:pointer">Upload<input type="file" id="b-fav-file" accept="image/*,.ico" style="display:none"></label>
                <button class="btn ghost small" type="button" id="b-fav-pick">Library…</button></span></label>
            </div>
            <div class="form-row">
              <label class="fld"><span>Logo size — height ${' '}<small style="color:var(--muted)">(32–72 px, default 48)</small></span>
                <span style="display:flex;gap:10px;align-items:center">
                  <input type="range" id="b-logoheight" min="32" max="72" step="1" value="${esc(s.logo_height || '48')}" style="flex:1">
                  <input type="number" id="b-logoheight-num" min="32" max="72" value="${esc(s.logo_height || '48')}" style="width:76px"> px
                </span></label>
            </div>
          </div>
          <div class="panel" style="margin-top:14px"><h3>Colors</h3>
            <div class="form-row">
              ${colorRow('b-primary', 'Primary color', s.primary_color)}
              ${colorRow('b-accent', 'Accent color', s.accent_color)}
            </div>
            <h4 style="margin:12px 0 4px">Dark mode</h4>
            <div class="form-row3">
              ${colorRow('b-dbg', 'Background', s.dark_bg)}
              ${colorRow('b-dsurf', 'Surface / cards', s.dark_surface)}
              ${colorRow('b-dtext', 'Text', s.dark_text)}
            </div>
            <h4 style="margin:12px 0 4px">Light mode</h4>
            <div class="form-row3">
              ${colorRow('b-lbg', 'Background', s.light_bg)}
              ${colorRow('b-lsurf', 'Surface / cards', s.light_surface)}
              ${colorRow('b-ltext', 'Text', s.light_text)}
            </div>
          </div>
          <div class="panel" style="margin-top:14px"><h3>Homepage hero</h3>
            <label class="fld"><span>Hero title</span><input id="b-hero" value="${esc(s.hero_title)}"></label>
            <label class="fld"><span>Hero description</span><textarea id="b-herod" rows="2">${esc(s.hero_description)}</textarea></label>
            <label class="fld"><span>Background banner image <small style="color:var(--muted)">(recommended size: 1600 × 520 px)</small></span>
              <span style="display:flex;gap:8px"><input id="b-heroimg" value="${esc(s.hero_image_url || '')}" placeholder="/media/… or https://…" style="flex:1">
              <label class="btn ghost small" style="cursor:pointer">Upload<input type="file" id="b-hero-file" accept="image/*" style="display:none"></label>
              <button class="btn ghost small" type="button" id="b-hero-pick">Library…</button>
              <button class="btn ghost small" type="button" id="b-hero-clear">Clear</button></span></label>
            <div class="form-row3">
              <label class="fld"><span>Image fit</span><select id="b-herofit">
                <option value="cover" ${(s.hero_image_fit || 'cover') === 'cover' ? 'selected' : ''}>Cover (fill, cropped)</option>
                <option value="contain" ${s.hero_image_fit === 'contain' ? 'selected' : ''}>Contain (whole image)</option>
              </select></label>
              <label class="fld"><span>Image position</span><select id="b-heropos">
                ${['center', 'top', 'bottom', 'left', 'right'].map(p => `<option value="${p}" ${(s.hero_image_position || 'center') === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}
              </select></label>
              <label class="fld"><span>Dark overlay — <span id="b-overlay-val">${esc(s.hero_overlay || '55')}</span>%</span>
                <input type="range" id="b-overlay" min="0" max="95" step="1" value="${esc(s.hero_overlay || '55')}"></label>
            </div>
            <div class="check-row"><input type="checkbox" id="b-herocards" ${String(s.hero_show_cards ?? '1') === '1' ? 'checked' : ''}> <label for="b-herocards">Show decorative cards on the hero</label></div>
            <label class="fld"><span>Popular searches (one per line)</span><textarea id="b-pop" rows="4">${esc(JSON.parse(s.popular_searches || '[]').join('\n'))}</textarea></label>
          </div>
          <div class="panel" style="margin-top:14px"><h3>Footer</h3>
            <label class="fld"><span>Footer text</span><input id="b-footer" value="${esc(s.footer_text)}"></label>
            <label class="fld"><span>Copyright line</span><input id="b-copy" value="${esc(s.copyright_line)}" placeholder="© 2026 Your Company"></label>
            <div class="check-row"><input type="checkbox" id="b-powered" ${String(s.powered_by) === '1' ? 'checked' : ''}> <label for="b-powered">Show “Powered by XC Wiki”</label></div>
          </div>
          <div class="panel" style="margin-top:14px"><h3>Custom CSS</h3>
            <label class="fld"><span>Applied globally after the theme <small style="color:var(--muted)">(&lt;/style&gt; and @import are stripped)</small></span>
            <textarea id="b-css" rows="6" spellcheck="false" style="font-family:monospace;font-size:.8rem">${esc(s.custom_css)}</textarea></label>
          </div>
          <div style="margin:14px 0"><button class="btn" id="b-save">💾 Save branding</button></div>
        </div>
        <div>
          <div class="panel" style="position:sticky;top:12px"><h3>Live preview</h3>
            <p style="color:var(--muted);font-size:.8rem">Updates as you type. Save to apply site-wide.</p>
            <div id="b-preview" class="brand-preview"></div>
          </div>
        </div>
      </div>`;

    const paint = () => {
      const v = id => document.getElementById(id).value;
      const primary = v('b-primary'), accent = v('b-accent');
      const pv = document.getElementById('b-preview');
      pv.innerHTML = `
        <div class="bp-bar" style="border-bottom:3px solid ${esc(primary)}">
          <span class="bp-mark" style="background:linear-gradient(135deg,${esc(primary)},${esc(accent)})">${v('b-logourl') ? '🖼' : esc((v('b-logo') || v('b-title') || 'XC').trim().slice(0, 2).toUpperCase())}</span>
          <span><strong>${esc(v('b-title'))}</strong><br><small>${esc(v('b-tagline'))}</small></span>
        </div>
        <div class="bp-hero" style="background:linear-gradient(135deg,${esc(primary)}44,#101A33)${v('b-heroimg') ? `,url('${esc(v('b-heroimg'))}') center/${esc(v('b-herofit'))}` : ''}">
          <h3>${esc(v('b-hero'))}</h3>
          <p>${esc(v('b-herod')).slice(0, 140)}${v('b-herod').length > 140 ? '…' : ''}</p>
          <div class="bp-chips">${v('b-pop').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 4).map(x => `<span>${esc(x)}</span>`).join('')}</div>
        </div>
        <div class="bp-foot">${esc(v('b-footer'))}${v('b-copy') ? ' · ' + esc(v('b-copy')) : ''}${document.getElementById('b-powered').checked ? ' · Powered by XC Wiki' : ''}</div>`;
    };
    main.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', paint));
    // upload / library pickers for logo, favicon and hero image
    const wireImageField = (fileId, pickId, inputId, after) => {
      const input = document.getElementById(inputId);
      document.getElementById(pickId).onclick = () => this.openMediaPicker({ kind: 'image', title: 'Choose image', cb: (f) => { input.value = f.url; input.dispatchEvent(new Event('input')); if (after) after(f.url); } });
      document.getElementById(fileId).onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { const [up] = await this.uploadFiles([f]); input.value = up.url; input.dispatchEvent(new Event('input')); if (after) after(up.url); toast('Image uploaded', 'ok'); }
        catch (err) { toast(err.message, 'err'); }
      };
    };
    wireImageField('b-logo-file', 'b-logo-pick', 'b-logourl');
    wireImageField('b-fav-file', 'b-fav-pick', 'b-fav', (url) => {
      document.getElementById('b-fav-prev').innerHTML = url ? `<img src="${esc(url)}" style="width:20px;height:20px;object-fit:contain">` : '';
    });
    wireImageField('b-hero-file', 'b-hero-pick', 'b-heroimg');
    document.getElementById('b-hero-clear').onclick = () => {
      const i = document.getElementById('b-heroimg'); i.value = ''; i.dispatchEvent(new Event('input'));
    };
    const lh = document.getElementById('b-logoheight'), lhNum = document.getElementById('b-logoheight-num');
    lh.addEventListener('input', () => { lhNum.value = lh.value; });
    lhNum.addEventListener('input', () => { lh.value = lhNum.value; });
    document.getElementById('b-overlay').addEventListener('input', (e) => {
      document.getElementById('b-overlay-val').textContent = e.target.value;
    });
    // sync color text + picker pairs
    [['b-primary'], ['b-accent'], ['b-dbg'], ['b-dsurf'], ['b-dtext'], ['b-lbg'], ['b-lsurf'], ['b-ltext']].forEach(([id]) => {
      const picker = document.getElementById(id), txt = document.getElementById(id + '-txt');
      if (!picker || !txt) return;
      picker.addEventListener('input', () => { txt.value = picker.value; paint(); });
      txt.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(txt.value)) picker.value = txt.value; paint(); });
    });
    paint();

    document.getElementById('b-save').onclick = async () => {
      const v = id => document.getElementById(id).value;
      const payload = {
        site_title: v('b-title'), site_tagline: v('b-tagline'), logo_text: v('b-logo'),
        logo_url: v('b-logourl'), logo_height: String(Math.max(32, Math.min(72, parseInt(v('b-logoheight-num'), 10) || 48))),
        favicon_url: v('b-fav'), default_theme: v('b-theme'),
        primary_color: v('b-primary-txt'), accent_color: v('b-accent-txt'),
        dark_bg: v('b-dbg-txt'), dark_surface: v('b-dsurf-txt'), dark_text: v('b-dtext-txt'),
        light_bg: v('b-lbg-txt'), light_surface: v('b-lsurf-txt'), light_text: v('b-ltext-txt'),
        hero_title: v('b-hero'), hero_description: v('b-herod'),
        hero_image_url: v('b-heroimg'), hero_image_fit: v('b-herofit'), hero_image_position: v('b-heropos'),
        hero_overlay: v('b-overlay'), hero_show_cards: document.getElementById('b-herocards').checked ? '1' : '0',
        popular_searches: JSON.stringify(v('b-pop').split('\n').map(x => x.trim()).filter(Boolean)),
        footer_text: v('b-footer'), copyright_line: v('b-copy'),
        powered_by: document.getElementById('b-powered').checked ? '1' : '0',
        custom_css: v('b-css'),
      };
      try {
        const updated = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
        App.settings = { ...App.settings, ...updated };
        try { App.settings.popular_searches = JSON.parse(updated.popular_searches || '[]'); } catch {}
        applyBranding(App.settings);
        toast('Branding saved — applied instantly', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  },

  /* ---------- cloud backup ---------- */

  async backup(main) {
    const [conns, bset, backups] = await Promise.all([
      api('/api/admin/cloud/connections'),
      api('/api/admin/cloud/settings'),
      api('/api/admin/cloud/backups'),
    ]);
    const origin = location.origin;
    const guide = (provider) => {
      const isG = provider === 'google';
      const name = isG ? 'Google Drive' : 'OneDrive';
      const cb = `${origin}/api/admin/cloud/callback/${provider}`;
      const steps = isG ? [
        'Go to <a href="https://console.cloud.google.com" target="_blank">console.cloud.google.com</a> and create (or pick) a project.',
        'Enable the <strong>Google Drive API</strong> (APIs & Services → Library).',
        'APIs & Services → Credentials → <strong>Create Credentials → OAuth client ID</strong> → type <strong>Web application</strong>.',
        'Under <strong>Authorized redirect URIs</strong> add:<br><code>' + esc(cb) + '</code>',
        'Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields above and save.',
        'Click <strong>Connect</strong> and approve access in the Google window.',
      ] : [
        'Go to <a href="https://portal.azure.com" target="_blank">portal.azure.com</a> → Microsoft Entra ID → App registrations → <strong>New registration</strong>.',
        'Name it “XC Wiki Backup”. Supported account types: <strong>Accounts in any organizational directory and personal Microsoft accounts</strong>.',
        'Under <strong>Redirect URI</strong> choose <strong>Web</strong> and enter:<br><code>' + esc(cb) + '</code>',
        'Register → copy the <strong>Application (client) ID</strong>.',
        'Certificates & secrets → <strong>New client secret</strong> → copy the <strong>Value</strong> (not the ID).',
        'API permissions → add <strong>Files.ReadWrite</strong> and <strong>offline_access</strong> (delegated).',
        'Paste the client ID + secret value above, save, then click <strong>Connect</strong>.',
      ];
      return `<details class="guide"><summary>📖 Setup guide — create your ${name} OAuth app</summary><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol></details>`;
    };
    const card = (provider) => {
      const c = conns[provider];
      const name = provider === 'google' ? 'Google Drive' : 'OneDrive';
      const icon = provider === 'google' ? '🔵' : '🟦';
      return `<div class="panel"><h3>${icon} ${name}</h3>
        <div class="form-row">
          <label class="fld"><span>Client ID</span><input id="cc-${provider}-id" value="${esc(c.client_id)}" placeholder="…apps.googleusercontent.com"></label>
          <label class="fld"><span>Client secret ${c.has_client_secret ? '(saved ✓ — leave blank to keep)' : ''}</span><input id="cc-${provider}-secret" type="password" placeholder="${c.has_client_secret ? '••••••••' : 'paste secret'}"></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn ghost small" data-ccsave="${provider}">Save credentials</button>
          ${c.configured ? `<button class="btn small" data-ccconnect="${provider}" ${c.connected ? 'disabled' : ''}>${c.connected ? '✅ Connected' : '🔗 Connect'}</button>` : ''}
          ${c.configured ? `<button class="btn ghost small" data-ccdrop="${provider}" style="color:var(--red)">Disconnect</button>` : ''}
          ${c.connected ? `<button class="btn small" data-ccbackup="${provider}">☁️ Backup now</button>` : ''}
        </div>
        ${c.last_error ? `<p style="color:var(--red);font-size:.8rem">⚠️ ${esc(c.last_error)}</p>` : ''}
        ${c.connected_at ? `<p style="color:var(--muted);font-size:.8rem">Connected ${timeAgo(c.connected_at)} · folder “${esc(c.folder_name)}”</p>` : ''}
        ${guide(provider)}
      </div>`;
    };
    main.innerHTML = `<h2 style="margin-top:0">☁️ Cloud Backup</h2>
      <p style="color:var(--muted);font-size:.88rem">Encrypted OAuth tokens, timestamped zip backups (database + uploads + manifest with checksums), scheduled backups, per-provider retention, and one-click restore with a safety backup taken first.</p>
      <div class="two-col">
        <div>${card('google')}</div>
        <div>${card('onedrive')}</div>
      </div>
      <div class="panel" style="margin-top:14px"><h3>Schedule</h3>
        <div class="form-row3">
          <label class="fld"><span>Frequency</span><select id="bs-freq">
            ${['off', 'daily', 'weekly'].map(f => `<option value="${f}" ${bset.freq === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}
          </select></label>
          <label class="fld"><span>Run at (local server time)</span><input id="bs-time" type="time" value="${esc(bset.time)}"></label>
          <label class="fld"><span>Keep last N backups (per provider)</span><input id="bs-ret" type="number" min="1" max="100" value="${bset.retention}"></label>
        </div>
        <div style="margin-top:8px"><button class="btn small" id="bs-save">Save schedule</button></div>
      </div>
      <div class="panel" style="margin-top:14px"><h3>Backups (${backups.length})</h3>
        <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>File</th><th>Provider</th><th>Size</th><th>Created</th><th>Status</th><th></th></tr></thead>
        <tbody>${backups.map(b => `
          <tr><td><code style="font-size:.75rem">${esc(b.filename)}</code>${b.is_safety ? ' <span class="pill scheduled">safety</span>' : ''}<br>
            <small style="color:var(--muted2)">${b.summary && b.summary.counts ? `${b.summary.counts.articles || 0} articles · ${b.summary.counts.customers || 0} customers` : ''}</small></td>
          <td>${esc(b.provider)}</td><td>${(b.size_bytes / 1024).toFixed(0)} KB</td><td style="white-space:nowrap">${timeAgo(b.created_at)}</td>
          <td>${b.status === 'ok' ? '<span class="pill published">ok</span>' : `<span class="pill archived">${esc(b.status)}</span>`}</td>
          <td style="white-space:nowrap">
            <button class="link-btn" data-bdl="${b.id}">Download</button> ·
            <button class="link-btn" data-brestore="${b.id}">Restore</button> ·
            <button class="link-btn" data-bdel="${b.id}" style="color:var(--red)">Delete</button>
          </td></tr>`).join('') || '<tr><td colspan="6" class="empty">No backups yet. Connect a provider and run your first backup.</td></tr>'}
        </tbody></table></div>
      </div>`;

    main.querySelectorAll('[data-ccsave]').forEach(b => b.onclick = async () => {
      const p = b.dataset.ccsave;
      try {
        await api('/api/admin/cloud/credentials', { method: 'POST', body: JSON.stringify({
          provider: p,
          client_id: document.getElementById(`cc-${p}-id`).value,
          client_secret: document.getElementById(`cc-${p}-secret`).value,
        }) });
        toast('Credentials saved', 'ok'); this.backup(main);
      } catch (e) { toast(e.message, 'err'); }
    });
    main.querySelectorAll('[data-ccconnect]').forEach(b => b.onclick = async () => {
      const p = b.dataset.ccconnect;
      try {
        const d = await api(`/api/admin/cloud/auth-url/${p}`);
        window.open(d.url, '_blank', 'width=600,height=700');
        toast('Approve access in the popup, then refresh this page', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    main.querySelectorAll('[data-ccdrop]').forEach(b => b.onclick = async () => {
      if (!confirm('Disconnect this provider? Stored tokens are deleted.')) return;
      await api('/api/admin/cloud/connections/' + b.dataset.ccdrop, { method: 'DELETE' });
      toast('Disconnected', 'ok'); this.backup(main);
    });
    main.querySelectorAll('[data-ccbackup]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Backing up…';
      try {
        const r = await api('/api/admin/cloud/backup/' + b.dataset.ccbackup, { method: 'POST' });
        toast(`Backup complete: ${r.filename}`, 'ok'); this.backup(main);
      } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    });
    document.getElementById('bs-save').onclick = async () => {
      try {
        await api('/api/admin/cloud/settings', { method: 'PUT', body: JSON.stringify({
          freq: document.getElementById('bs-freq').value,
          time: document.getElementById('bs-time').value,
          retention: Number(document.getElementById('bs-ret').value),
        }) });
        toast('Schedule saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    main.querySelectorAll('[data-bdl]').forEach(b => b.onclick = () => {
      window.location = '/api/admin/cloud/backups/' + b.dataset.bdl + '/download';
    });
    main.querySelectorAll('[data-bdel]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this backup (also removes the cloud copy)?')) return;
      await api('/api/admin/cloud/backups/' + b.dataset.bdel, { method: 'DELETE' });
      toast('Backup deleted', 'ok'); this.backup(main);
    });
    main.querySelectorAll('[data-brestore]').forEach(b => b.onclick = async () => {
      if (!confirm('Restore this backup? A safety backup of the CURRENT data is taken first. The database is swapped without a restart.')) return;
      b.disabled = true;
      try {
        const r = await api('/api/admin/cloud/restore/' + b.dataset.brestore, { method: 'POST' });
        toast(`Restored backup from ${r.restored.created_at} (${r.restored.articles} articles)`, 'ok');
        setTimeout(() => location.reload(), 1200);
      } catch (e) { toast('Restore failed: ' + e.message, 'err'); b.disabled = false; }
    });
  },

  /* ---------- users ---------- */

  async users(main) {
    if (App.user.role !== 'admin') { main.innerHTML = '<div class="empty">Admins only.</div>'; return; }
    const rows = await api('/api/admin/users');
    main.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Users</h2>
      <button class="btn small" id="u-new">＋ Invite user</button></div>
      <table class="tbl" style="margin-top:12px"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
      ${rows.map(u => `<tr><td><strong>${esc(u.display_name)}</strong></td><td>${esc(u.email)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'scheduled' : 'draft'}">${u.role}</span></td>
        <td>${u.disabled ? '<span class="pill archived">disabled</span>' : '<span class="pill published">active</span>'}</td>
        <td>${timeAgo(u.created_at)}</td>
        <td style="white-space:nowrap"><button class="link-btn" data-uedit="${u.id}">Edit</button> · <button class="link-btn" data-udel="${u.id}" style="color:var(--red)">Delete</button></td></tr>`).join('')}
      </tbody></table><div id="u-form"></div>`;

    const form = (u) => {
      document.getElementById('u-form').innerHTML = `
        <div class="panel" style="margin-top:14px"><h3>${u ? 'Edit user' : 'Invite user'}</h3>
        <div class="form-row">
          <label class="fld"><span>Display name</span><input id="u-name" value="${esc(u?.display_name || '')}"></label>
          <label class="fld"><span>Email</span><input id="u-email" type="email" value="${esc(u?.email || '')}" ${u ? 'disabled' : ''}></label>
        </div>
        <div class="form-row3">
          <label class="fld"><span>Role</span><select id="u-role">${['admin', 'editor', 'viewer'].map(r => `<option ${u?.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <label class="fld"><span>New password ${u ? '(blank = keep)' : ''}</span><input id="u-pass" type="password" placeholder="${u ? '—' : '8+ characters'}"></label>
          <label class="fld"><span>Status</span><select id="u-dis"><option value="0" ${!u?.disabled ? 'selected' : ''}>Active</option><option value="1" ${u?.disabled ? 'selected' : ''}>Disabled</option></select></label>
        </div>
        <div style="display:flex;gap:8px"><button class="btn small" id="u-save">Save</button><button class="btn ghost small" id="u-cancel">Cancel</button></div></div>`;
      document.getElementById('u-cancel').onclick = () => this.users(main);
      document.getElementById('u-save').onclick = async () => {
        const payload = {
          display_name: document.getElementById('u-name').value,
          role: document.getElementById('u-role').value,
          disabled: document.getElementById('u-dis').value === '1',
        };
        const pw = document.getElementById('u-pass').value;
        if (pw) payload.password = pw;
        try {
          if (u) await api('/api/admin/users/' + u.id, { method: 'PUT', body: JSON.stringify(payload) });
          else {
            payload.email = document.getElementById('u-email').value;
            if (!payload.password || payload.password.length < 8) { toast('Password of 8+ characters is required', 'err'); return; }
            await api('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) });
          }
          toast('Saved', 'ok'); this.users(main);
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    document.getElementById('u-new').onclick = () => form(null);
    main.querySelectorAll('[data-uedit]').forEach(b => b.onclick = () => form(rows.find(u => String(u.id) === b.dataset.uedit)));
    main.querySelectorAll('[data-udel]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this user?')) return;
      try { await api('/api/admin/users/' + b.dataset.udel, { method: 'DELETE' }); toast('Deleted', 'ok'); this.users(main); }
      catch (e) { toast(e.message, 'err'); }
    });
  },

  /* ---------- "View as" visibility tester ---------- */

  async viewAs(main) {
    const customers = await api('/api/admin/customers?').catch(() => []);
    main.innerHTML = `<h2 style="margin-top:0">👁 View As — visibility tester</h2>
      <p style="color:var(--muted);font-size:.88rem">See exactly what each audience can see: home sections, categories, and a sample search. Restricted content never leaks — this runs the same server-side filters readers get.</p>
      <div class="toolbar">
        <select id="va-mode" style="max-width:260px">
          <option value="anon">🌍 Anonymous visitor</option>
          <option value="staff">🛠 Staff</option>
          ${customers.map(c => `<option value="customer:${c.id}">🙋 ${esc(c.name)} (${esc(c.group_name || 'no group')})</option>`).join('')}
        </select>
        <button class="btn small" id="va-go">Preview</button>
      </div>
      <div id="va-out"></div>`;
    document.getElementById('va-go').onclick = async () => {
      const mode = document.getElementById('va-mode').value;
      const out = document.getElementById('va-out');
      out.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const d = await api('/api/admin/visibility-preview?viewer=' + encodeURIComponent(mode));
        const list = (items) => items.map(a => `<div class="art-row"><a class="t" style="font-size:.86rem" href="#/article/${esc(a.slug)}">${esc(a.title)}</a></div>`).join('') || '<div class="empty">Nothing visible.</div>';
        out.innerHTML = `
          <div class="panel"><h3>Viewing as: ${esc(mode)}</h3>
            <div class="two-col">
              <div><h4>Featured</h4><div class="art-list">${list(d.home.featured)}</div></div>
              <div><h4>Recently updated</h4><div class="art-list">${list(d.home.recent)}</div></div>
            </div>
          </div>
          <div class="panel" style="margin-top:12px"><h3>Categories</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${d.categories.map(c => `<span class="chip">${esc(c.name)} ${c.visibility === 'staff' ? '🔒' : ''}</span>`).join('')}</div>
          </div>
          <div class="panel" style="margin-top:12px"><h3>Sample search: “guide”</h3><div class="art-list">${list(d.search_sample)}</div></div>`;
      } catch (e) { out.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`; }
    };
  },

  /* ---------- demo content manager ---------- */

  async demoContent(main) {
    const d = await api('/api/admin/demo');
    const card = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    main.innerHTML = `<h2 style="margin-top:0">🧪 Demo Content</h2>
      <p style="color:var(--muted);font-size:.88rem">The sample content this install was seeded with. Removing it deletes <strong>only</strong> the seeded rows listed below — articles, customers and groups you created yourself are never touched. Restore brings the seeded rows back.</p>
      <div class="stat-grid">
        ${card(d.articles, 'Demo articles')}
        ${card(d.categories, 'Demo categories')}
        ${card(d.services, 'Demo services')}
        ${card(d.tags, 'Demo tags')}
        ${card(d.customers, 'Demo customers')}
        ${card(d.groups, 'Demo groups')}
      </div>
      <div class="panel">
        <h3>${d.present ? 'Demo content is installed' : 'Demo content is removed'}</h3>
        <p style="color:var(--muted);font-size:.85rem">${d.present
          ? 'Remove the seeded demo rows to start from a clean slate. Demo categories, services or groups that your own articles now use are kept and reported.'
          : 'Nothing seeded is currently present. Restore re-creates the demo articles, categories, services, tags, demo customers and groups.'}</p>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn danger small" id="demo-remove" ${d.present ? '' : 'disabled'}>Remove demo content</button>
          <button class="btn small" id="demo-restore">Restore demo content</button>
        </div>
        <div id="demo-result" style="margin-top:12px;font-size:.85rem"></div>
      </div>`;
    const out = document.getElementById('demo-result');
    document.getElementById('demo-remove').onclick = async () => {
      if (!confirm('Remove all seeded demo content? Your own content is not affected.')) return;
      try {
        const r = await api('/api/admin/demo/remove', { method: 'POST' });
        const sk = r.skipped || {};
        out.innerHTML = `✅ Removed ${r.removed.articles} article(s), ${r.removed.categories} categories, ${r.removed.services} services, ${r.removed.tags} tag(s), ${r.removed.customers} customer(s), ${r.removed.groups} group(s).` +
          ((sk.categories || sk.services || sk.groups) ? `<br>⚠️ Kept ${sk.categories || 0} categories, ${sk.services || 0} services, ${sk.groups || 0} groups because your own articles use them.` : '');
        toast('Demo content removed', 'ok');
        setTimeout(() => this.demoContent(main), 1600);
      } catch (e) { out.innerHTML = '❌ ' + esc(e.message); }
    };
    document.getElementById('demo-restore').onclick = async () => {
      try {
        const r = await api('/api/admin/demo/restore', { method: 'POST' });
        out.innerHTML = `✅ Restored ${r.restored.articles} article(s), ${r.restored.categories} categories, ${r.restored.services} services, ${r.restored.customers} customer(s), ${r.restored.groups} group(s).`;
        toast('Demo content restored', 'ok');
        setTimeout(() => this.demoContent(main), 1600);
      } catch (e) { out.innerHTML = '❌ ' + esc(e.message); }
    };
  },

  /* ---------- BookStack import ---------- */

  async bookstack(main) {
    main.innerHTML = `<h2 style="margin-top:0">📚 BookStack Import</h2>
      <p style="color:var(--muted);font-size:.88rem">Import a whole BookStack instance: <strong>Books become categories</strong> and <strong>Pages become articles</strong> with their HTML formatting preserved. Images and attachments referenced by the pages are downloaded into this wiki's Media Library and the content is rewritten to the new hosted paths; links between imported pages are rewired to the new articles. Create an API token in BookStack under <em>your profile → API Tokens</em>. You can <strong>save the connection</strong> so later imports don't need the token re-typed — the Token Secret is stored encrypted and is never shown again. Credentials typed here take precedence over the saved connection for that run.</p>
      <div class="panel">
        <div id="bs-saved" style="font-size:.88rem;margin-bottom:10px"></div>
        <div class="form-row3">
          <label class="fld"><span>BookStack base URL</span><input id="bs-url" placeholder="https://wiki.example.com"></label>
          <label class="fld"><span>API Token ID</span><input id="bs-tid" autocomplete="off"></label>
          <label class="fld"><span>API Token Secret</span><input id="bs-tsecret" type="password" autocomplete="off"></label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn ghost small" id="bs-test">Test connection</button>
          <button class="btn ghost small" id="bs-save">💾 Save connection</button>
          <button class="btn ghost small danger" id="bs-remove" style="display:none">Remove saved connection</button>
          <span id="bs-test-out" style="font-size:.85rem"></span>
        </div>
        <small style="color:var(--muted)">With a connection saved, Test and Import work with the fields left blank. Typing a new Token Secret uses it for that run instead; leave it blank when saving to keep the saved secret unchanged.</small>
      </div>
      <div class="panel" style="margin-top:14px"><h3>Import options</h3>
        <div class="form-row3">
          <label class="fld"><span>Imported articles</span><select id="bs-status">
            <option value="published">Published</option><option value="draft">Drafts</option>
          </select></label>
          <label class="fld"><span>Visibility</span><select id="bs-vis">
            <option value="all">🌍 Everyone</option><option value="staff">🔒 Staff only</option>
          </select></label>
          <label class="fld"><span>Re-runs</span>
            <span class="check-row" style="margin:6px 0"><input type="checkbox" id="bs-update"> <label for="bs-update">Update articles that were already imported</label></span>
            <small style="color:var(--muted)">Off = previously imported pages are skipped (nothing duplicates either way; imported media is always reused).</small>
          </label>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="bs-run">⬇ Start import</button>
        </div>
        <div id="bs-progress" style="margin-top:14px"></div>
        <div id="bs-summary" style="margin-top:10px"></div>
      </div>`;

    const creds = () => ({
      base_url: document.getElementById('bs-url').value,
      token_id: document.getElementById('bs-tid').value,
      token_secret: document.getElementById('bs-tsecret').value,
    });
    const savedBox = document.getElementById('bs-saved');
    const paintSaved = (c) => {
      const removeBtn = document.getElementById('bs-remove');
      const secretInput = document.getElementById('bs-tsecret');
      if (c && c.saved) {
        savedBox.innerHTML = `🔐 <strong>Saved connection:</strong> ${esc(c.base_url)} · Token ID ${esc(c.token_id)} · Secret ${esc(c.secret_masked || '••••')}${c.saved_at ? ` · saved ${esc(String(c.saved_at).slice(0, 10))}` : ''}${c.readable ? '' : ' · <span style="color:var(--amber)">⚠️ saved secret can no longer be decrypted — remove and save again</span>'}`;
        if (!document.getElementById('bs-url').value) document.getElementById('bs-url').value = c.base_url || '';
        if (!document.getElementById('bs-tid').value) document.getElementById('bs-tid').value = c.token_id || '';
        secretInput.placeholder = (c.secret_masked || '••••') + ' — leave blank to keep';
        removeBtn.style.display = '';
      } else {
        savedBox.innerHTML = 'No saved connection yet — enter the details and choose <strong>Save connection</strong> to reuse them for later imports.';
        secretInput.placeholder = '';
        removeBtn.style.display = 'none';
      }
    };
    try { paintSaved(await api('/api/admin/bookstack/connection')); } catch { savedBox.textContent = ''; }
    document.getElementById('bs-save').onclick = async () => {
      const out = document.getElementById('bs-test-out');
      try {
        const c = await api('/api/admin/bookstack/connection', { method: 'PUT', body: JSON.stringify(creds()) });
        document.getElementById('bs-tsecret').value = '';
        paintSaved(c);
        toast('BookStack connection saved', 'ok');
        out.innerHTML = '✅ Connection saved — later imports can leave the fields blank.';
      } catch (e) { out.innerHTML = '❌ ' + esc(e.message); }
    };
    document.getElementById('bs-remove').onclick = async () => {
      if (!confirm('Remove the saved BookStack connection? The stored Token Secret will be deleted.')) return;
      try {
        const c = await api('/api/admin/bookstack/connection', { method: 'DELETE' });
        document.getElementById('bs-tsecret').value = '';
        paintSaved(c);
        toast('Saved BookStack connection removed', 'ok');
      } catch (e) { toast('Remove failed: ' + e.message, 'err'); }
    };
    document.getElementById('bs-test').onclick = async () => {
      const out = document.getElementById('bs-test-out');
      out.textContent = 'Testing…';
      try {
        const d = await api('/api/admin/bookstack/test', { method: 'POST', body: JSON.stringify(creds()) });
        out.innerHTML = `✅ Connected to ${esc(d.base_url)} — <strong>${d.books}</strong> book(s), <strong>${d.pages}</strong> page(s) available.`;
      } catch (e) { out.innerHTML = '❌ ' + esc(e.message); }
    };
    document.getElementById('bs-run').onclick = async () => {
      const prog = document.getElementById('bs-progress');
      const sum = document.getElementById('bs-summary');
      sum.innerHTML = '';
      try {
        const payload = { ...creds(),
          status: document.getElementById('bs-status').value,
          visibility: document.getElementById('bs-vis').value,
          update_existing: document.getElementById('bs-update').checked };
        const d = await api('/api/admin/bookstack/import', { method: 'POST', body: JSON.stringify(payload) });
        const jobId = d.job.id;
        toast('BookStack import started', 'ok');
        const poll = async () => {
          const s = await api('/api/admin/bookstack/import/status?id=' + encodeURIComponent(jobId));
          const j = s.job;
          if (!j) { prog.innerHTML = 'Import job not found.'; return; }
          const pct = j.progress.pages_total ? Math.round((j.progress.pages_done / j.progress.pages_total) * 100) : 0;
          prog.innerHTML = j.status === 'running'
            ? `<div style="font-size:.85rem;margin-bottom:6px">⏳ ${esc(j.progress.phase)}${j.progress.current ? ' — ' + esc(j.progress.current) : ''} (${j.progress.pages_done}/${j.progress.pages_total} pages)</div>
               <div class="progress" style="height:8px"><div style="width:${pct}%"></div></div>`
            : '';
          if (j.status === 'running') { setTimeout(poll, 1000); return; }
          if (j.status === 'failed') { sum.innerHTML = `<div class="empty">❌ Import failed: ${esc(j.error || 'unknown error')}</div>`; return; }
          const x = j.summary || {};
          const cell = (n, l) => `<div class="stat"><div class="n">${n ?? 0}</div><div class="l">${l}</div></div>`;
          sum.innerHTML = `<h3>✅ Import complete</h3>
            <div class="stat-grid">
              ${cell(x.categories_created, 'Categories created')}${cell(x.categories_reused, 'Categories reused')}
              ${cell(x.articles_created, 'Articles created')}${cell(x.articles_updated, 'Articles updated')}
              ${cell(x.articles_skipped, 'Articles skipped')}${cell(x.media_imported, 'Media imported')}
              ${cell(x.media_reused, 'Media reused')}${cell(x.links_rewritten, 'Links rewritten')}
              ${cell(x.covers_set, 'Book covers set')}
            </div>
            ${x.media_failed ? `<p style="color:var(--amber);font-size:.85rem">⚠️ ${x.media_failed} media file(s) failed to download.</p>` : ''}
            ${x.failures && x.failures.length ? `<h4>Failures (${x.failures.length})</h4><div style="max-height:220px;overflow:auto"><table class="tbl"><thead><tr><th>Type</th><th>Item</th><th>Error</th></tr></thead>
              <tbody>${x.failures.map(f => `<tr><td>${esc(f.type)}</td><td>${esc(f.name)}</td><td>${esc(f.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}
            <p style="font-size:.85rem"><a href="#/admin/articles">Review imported articles →</a> · <a href="#/admin/media">Open Media Library →</a></p>`;
        };
        poll();
      } catch (e) { sum.innerHTML = `<div class="empty">❌ ${esc(e.message)}</div>`; }
    };
  },

  /* ---------- settings ---------- */

  async settings(main) {
    main.innerHTML = `<h2 style="margin-top:0">Settings</h2>
      <div class="panel"><h3>🎨 Branding</h3>
        <p style="color:var(--muted);font-size:.85rem">Site title, logo, colors, hero, footer and custom CSS now live in the dedicated panel.</p>
        <a class="btn small" href="#/admin/branding">Open Site & Branding →</a>
      </div>
      <div class="panel" style="margin-top:14px"><h3>Import / Export</h3>
        <p style="color:var(--muted);font-size:.85rem">Export everything as JSON (articles are stored as sanitized HTML in v2). Import brings articles in as drafts.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" id="s-export">⬇ Export JSON</button>
          <label class="btn ghost small" style="cursor:pointer">⬆ Import JSON<input type="file" id="s-import" accept=".json" style="display:none"></label>
        </div>
      </div>`;
    document.getElementById('s-export').onclick = () => { window.location = '/api/admin/export'; };
    document.getElementById('s-import').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const r = await api('/api/admin/import', { method: 'POST', body: JSON.stringify(data) });
        toast(`Imported ${r.imported} article(s) as drafts`, 'ok');
      } catch (err) { toast('Import failed: ' + err.message, 'err'); }
    };
  },
};

/* Simple line-based diff for version comparison. */
function lineDiff(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  // LCS on lines (fine for article-sized docs)
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  let i = 0, j = 0;
  let html = '<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-top:8px">';
  while (i < m && j < n) {
    if (a[i] === b[j]) { html += `<div class="diff-line">${esc(a[i]) || ' '}</div>`; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { html += `<div class="diff-line diff-old">− ${esc(a[i])}</div>`; i++; }
    else { html += `<div class="diff-line diff-new">+ ${esc(b[j])}</div>`; j++; }
  }
  while (i < m) html += `<div class="diff-line diff-old">− ${esc(a[i++])}</div>`;
  while (j < n) html += `<div class="diff-line diff-new">+ ${esc(b[j++])}</div>`;
  return html + '</div>';
}
