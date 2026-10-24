# XC Wiki

A knowledge base / wiki website system: a public reader portal (search, categories, services, article pages with table of contents, feedback, reading progress) plus a staff admin dashboard (WYSIWYG HTML editor, revision history with diff + rollback, categories/services/tags, media library, redirects, customer groups with per-group article visibility, cloud backup, user roles, feedback inbox, search analytics, import/export).

Stack: **Node 20 + Express + better-sqlite3**, vanilla JS SPA. No build step — clone, `npm install`, `npm start`.

## Screenshots

| Home | Article |
|---|---|
| ![XC Wiki home](https://files.catbox.moe/b81v3b.jpg) | ![Article page](https://files.catbox.moe/anooq3.jpg) |

| WYSIWYG editor | Admin dashboard |
|---|---|
| ![WYSIWYG editor](https://n.uguu.se/bCyrKwEt.jpg) | ![Admin dashboard](https://d.uguu.se/eNLzKsbN.jpg) |

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

On first run you'll be sent to a **setup screen** to create the administrator account (no hardcoded credentials). Public reading needs no login.

Set `ENCRYPTION_KEY` in production (a 64-char hex string, e.g. from `openssl rand -hex 32`) — it encrypts cloud-backup OAuth tokens at rest. Without it, a dev fallback key is used and a warning is printed.

## Recommended server specs

XC Wiki is a lightweight Node + SQLite app — no separate database or services needed.

| | Minimum | Comfortable |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1 GB |
| Disk | 5 GB (plus room for uploads/backups) | 20 GB |

Any $4–6/month VPS (Hetzner CX11, DigitalOcean Basic, etc.) runs it fine. Backups to Google Drive/OneDrive don't need extra disk.

## Deploy with Coolify

Self-host in a few clicks. You need a Coolify instance connected to your server.

**Option A — from this Git repo (recommended)**
1. In Coolify: **Projects → your project → Add → Service → Docker Compose**, and point it at this repository.
2. **Environment variables** — add:
   - `ENCRYPTION_KEY` = output of `openssl rand -hex 32` (required for Cloud Backup; set once, never change it)
3. **Persistent storage** — the compose file already declares the `xcwiki-data` volume mounted at `/app/data` (SQLite database + uploads). In Coolify's service → **Storages**, confirm a persistent volume is attached at `/app/data`.
4. Click **Deploy**. The healthcheck hits `/api/settings/public`; Coolify shows the service healthy when it responds.
5. Open the app URL — the first-run screen creates your admin account. No demo data is seeded.

**Option B — plain Docker Compose**
```bash
cp .env.example .env        # then set ENCRYPTION_KEY inside .env
docker compose up -d --build
# open http://localhost:3000
```

The SQLite database and uploads live in the `xcwiki-data` volume (`/app/data`). For off-site copies, use the built-in Cloud Backup (Google Drive / OneDrive) instead of only relying on volume snapshots.

## Features

**Reader**
- Home: hero search, popular searches, category cards, service cards, Continue Reading (progress resume), Recommended, Browse by Service, Recently Updated / Popular panels
- Article pages: breadcrumbs, auto table of contents, rich HTML content (tables, images, code blocks, video), reading progress bar, view counting, "Was this helpful?" feedback, related articles, prev/next
- Restricted articles show a 🔒 badge to signed-in customers who can access them; invisible content never appears (not even in search) for those without access
- Global search (Ctrl+K) with highlighted matches + ranked results; popular searches; search analytics
- Category / service / tag pages; Light / Dark / System theme; fully responsive
- Customer login + My Account (change password); staff login

**Wiki core**
- WYSIWYG rich-text editor (Write | HTML source | Preview tabs): formatting, headings, lists, quotes, code blocks, tables, links, images (from media library), alignment, text color/highlight, undo/redo
- Articles store sanitized HTML (scripts/iframes/event handlers stripped server-side); existing Markdown content is auto-converted to HTML on upgrade
- Drafts / published / scheduled / archived states, scheduled publishing
- Nested categories, tags, admin-manageable services
- Full revision history: every save is a version; diff view + one-click rollback
- Featured / pinned articles; file attachments + image uploads with media library
- Redirects (renaming an article keeps the old URL working)
- Continue Reading: per-article progress (localStorage for anonymous readers)

**Visibility model**
- Articles: **Everyone** · **Customer groups** (one or more groups) · **Staff only**
- Categories: **Everyone** · **Staff only** (hides the category and all its articles from readers)
- Enforced **server-side** on every read path (home, article fetch, search, taxonomy pages, related, prev/next, feedback). Forbidden articles return 404 — no title leak.
- Guardrails: publishing a group-restricted article with no group selected is refused server-side; new articles default to Published with a **Save & Publish** action; the Articles list shows each group article's groups and offers one-click Publish for drafts; signed-in staff browsing the reader site see every published article (group-restricted and staff-only included).
- Admin "👁 View As" tester previews the site as anonymous / staff / any customer.

**Customers & groups**
- Customers: name, email (login), company, phone, notes, group, active/disabled. Admin sets or auto-generates the initial password (shown once).
- Groups: name, color, description, customer counts.
- CSV import with column-mapping preview and per-row error reporting; bulk group assignment.
- Customer auth is separate from staff auth (email + password, "My Account" page, self-service password change).

**Cloud backup (Google Drive + OneDrive)**
- In-app setup guides for creating Google / Microsoft OAuth apps; tokens encrypted with `ENCRYPTION_KEY`, auto-refresh
- "Backup Now" → timestamped zip (SQLite DB + uploads + `manifest.json` with SHA-256 checksums)
- Scheduled Daily/Weekly backups, per-provider retention (default 10)
- Backup list with download / delete; restore with safety backup first, integrity + checksum validation, DB swapped without restart

**Staff admin**
- Dashboard: article/view/draft/customer/group counts, feedback score, activity feed
- Article manager: search/filter (incl. visibility), bulk publish / unpublish / archive / **set visibility** / delete
- Category / service / tag / redirect managers (categories have the staff-only toggle); user management with roles (admin, editor, viewer)
- Preview-as-customer mode (purple banner); feedback inbox; search analytics (top + no-result queries)
- 🎨 Site & Branding: title, tagline, logo (image upload + adjustable height 32–72 px) + favicon (image upload), primary/accent colors, dark/light theme colors, hero banner image editor (recommended 1600 × 520 px; fit, position and dark-overlay controls, optional decorative cards), footer, copyright, powered-by toggle, custom CSS — with live preview, applied instantly everywhere. Categories carry a BookStack-style **cover image** as their lead visual on cards and listings (upload via the Media Library; the emoji icon remains only as a fallback when no cover is set).
- Settings: JSON import/export

### Media library

- WordPress-style library (Admin → Media): batch or single uploads via multi-file picker or drag & drop — images, videos, audio, PDFs, logs, zips up to 15 MB each, all hosted on the instance under `/media/…`
- Grid/list views, search, type filters, sorting, per-file metadata (title, alt text, caption, attach-to-article), hosted-URL copy, single/bulk delete
- The WYSIWYG editor inserts Image / Video / File from the library (upload in place or pick an existing upload); article pages render attached media

### BookStack import

- Admin → BookStack Import: enter the instance URL + API token (used only for the run, never saved), test the connection, then import
- Books → categories, Pages → articles (chapter kept as a tag, page tags + author carried over, drafts stay drafts, HTML formatting preserved); each book's cover image is downloaded into the Media Library and set as the category's cover
- Referenced images and page attachments are downloaded into the Media Library and the content is rewritten to the new hosted paths; links between imported pages are rewired to the new articles
- Progress + completion summary; re-runs are idempotent (skip by default, or update in place) — no duplicates

### Demo content

- Admin → Demo Content shows live counts of the seeded rows and can Remove / Restore them; only seeded rows are ever touched — your own content survives a remove/restore cycle untouched

## Demo credentials (seeded)

- **Customers** (password `customer123` for all three):
  - `priya@example.com` — Priya Sharma, **Premium** group
  - `tom@example.com` — Tom Becker, **Premium** group
  - `rita@example.com` — Rita Alvarez, **Reseller** group
- **Restricted demo content**: `premium-priority-support` (Premium group), `reseller-white-label-setup` (Reseller group), `internal-incident-response` + the **Internal Ops** category (staff only)
- Try the **👁 View As** tester in the admin dashboard to see exactly what each audience sees.

## API overview

Public: `GET /api/settings/public`, `GET /api/home`, `GET /api/articles/:slug` (follows redirects, counts views), `GET /api/search?q=`, `GET /api/categories[/:slug]`, `GET /api/services[/:slug]`, `GET /api/tags[/:slug]`, `POST /api/articles/:id/feedback`, `GET|POST /api/progress`.

Auth: `GET /api/setup-needed`, `POST /api/setup` (first run only), `POST /api/auth/login|logout`, `GET /api/me` (staff or customer).
Customer auth: `POST /api/customer/login|logout`, `PUT /api/customer/password`.

Admin (Bearer token, editor+; user/group management is admin-only): `/api/admin/stats`, `/api/admin/articles` (+`/:id`, `/bulk` incl. `set-visibility`), `/api/admin/articles/:id/versions`, `.../rollback/:versionId`, `/api/admin/preview`, `/api/admin/visibility-preview?viewer=`, `/api/admin/{categories,services,tags,redirects}`, `/api/admin/users`, `/api/admin/groups`, `/api/admin/customers` (+`/import`, `/bulk-assign`), `/api/admin/upload`, `/api/admin/attachments`, `/api/admin/settings`, `/api/admin/feedback`, `/api/admin/search-analytics`, `/api/admin/activity`, `/api/admin/export`, `/api/admin/import`, `/api/admin/cloud/*` (connections, credentials, auth-url, callback, backup, backups, restore, settings).

## Project structure

```
server.js            Express app + all API routes
lib/
  db.js              SQLite schema, migrations, seed
  auth.js            Staff + customer auth tokens
  html.js            HTML sanitization
  cloud.js           Google Drive / OneDrive backup engine
  crypto.js          AES-256-GCM token encryption
  seed-data.js       Demo content
public/
  index.html         SPA shell
  js/                Reader + admin frontend
  css/               Theme (CSS variables, dark/light)
Dockerfile           Production image
docker-compose.yml   One-command deploy (Coolify-ready)
data/                SQLite DB + uploads (gitignored, created on first boot)
docs/screenshots/   App screenshots
```

## Data

SQLite at `data/xcwiki.db` (created + seeded on first boot with demo categories, services, articles, customer groups, customers, and restricted demo content). Uploads in `data/uploads/`. Cloud backups also keep timestamped safety copies in `data/safety-backups/` when no provider is connected.

Upgrading from the Markdown version: on first boot the migration renders every article and revision to sanitized HTML automatically and drops the old Markdown columns. A backup is recommended before upgrading.

## License

Private project — all rights reserved.
