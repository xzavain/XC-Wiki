# XC Wiki

A knowledge base / wiki website system: a public reader portal (search, categories, services, article pages with table of contents, feedback, reading progress) plus a staff admin dashboard (WYSIWYG HTML editor, revision history with diff + rollback, categories/services/tags, media library, redirects, customer groups with per-group article visibility, cloud backup, user roles, feedback inbox, search analytics, import/export).

Stack: **Node 22 + Express + better-sqlite3**, vanilla JS SPA. No build step — clone, `npm install`, `npm start`.

## What's new in 1.2.5

- **Admin → "Users" is now "Staff", grouped like Customers** — the page lists an **Admins** section first, then **Staff** (editors and viewers), each with its own count and the same row actions as before (edit, role, enable/disable, delete, services and groups). Only the labels changed — nothing about accounts, roles, or permissions moved.
- **Reorder articles inside a category** — Admin → Articles shows articles grouped by category; within each group, drag a row by its ⠿ handle or use the ↑ ↓ buttons and the new order saves immediately and is the order readers see on the category page. New articles join the end of their category, and moving an article to another category puts it at the end there. Pinned and featured articles keep their badges but follow the manual order on category pages (search and the homepage are unchanged).
- **Article images fit the screen** — images in articles now scale to the width available and keep their shape, even when the stored content carries fixed pixel sizes. On phones, pictures that were floated beside text stack full-width instead of squeezing everything sideways. Wide tables and code blocks still scroll sideways as before.
- **Staff sign-in sticks** — going from Admin to the public site and back no longer asks staff to sign in again: if you're already signed in as staff, the Admin link takes you straight to the dashboard, and a staff sign-in now lasts the full session (30 days), matching the sign-in cookie. Signing out still signs you out everywhere, and Preview as Customer never touches your staff session.
- **Articles can belong to several services** — the article editor now ticks services instead of picking just one. The article appears under every ticked service, its page shows a chip for each, and "Recommended for You" counts an article when *any* of its services is one of yours. Existing articles keep the service they already had.
- **Service pickers show names in boxes** — everywhere Admin attaches services to a person (customer editor, staff editor, invites, and the article editor), each service is now a box labeled with its name: ticked boxes are highlighted, unticked ones plain, so what's assigned is obvious at a glance.
- **The Services page is display-only** — service boxes no longer click through to per-service pages; the page simply shows the catalog. (Admin service management is unchanged.)
- **Editor: pick the quote color after you quote** — the Quote button inserts a plain quote and opens a style chooser (Default / Info / Success / Warning / Danger); clicking into any existing quote reopens the chooser for that quote, and hand-styled quotes from code editing convert to the chosen style when you pick one. Also new in the toolbar: **Justify** alignment and an **Anchor** button.
- **Anchors for article sections** — every heading in a published article automatically gets a link anchor from its text, so `/article/<slug>#<section>` lands right on that section (the page scrolls there, clear of the header). In the editor, the ⚓ Anchor button sets a custom anchor name on the heading or block you're in; links may point at `#anchor` directly.

## What's new in 1.2.4

- **The homepage "Your Services" section is gone** — the middle-of-the-page list of the viewer's attached services has been removed. The All Services page, the services catalog, and attaching services to users in Admin are all unchanged.
- **"Recommended for You" is now actually personal** — for a signed-in viewer with services attached, the list leads with guides for *their* services that they haven't read yet, then ones they started but didn't finish; guides already finished no longer take up a slot. If that runs short, the remaining slots fill with the featured guides, as before. Viewers without attached services see exactly what they saw before, and nobody ever sees another viewer's services or reading progress — recommendations are built from the viewer's own account and their own reading state only.

## What's new in 1.2.3

- **Reorder the homepage categories** — Admin → Categories now shows the categories in homepage order, and staff can change that order right there: drag a row by its ⠿ handle, or use the ↑ ↓ buttons on a row (the reliable way on a tablet). Changes save immediately and the homepage, category listings, and article groups all follow the same stored order. Staff signed in on the homepage can also drag category cards by their handle. New categories are added at the end of the order automatically (a sort-order number can still be typed to place one exactly), and existing sites keep the exact order they show today — the stored values are simply made unambiguous on first boot.

## What's new in 1.2.2

- **Homepage covers load fast** — category cover and page banner uploads are now stored at web size: a large photo uploaded as a cover is kept at most 1600 × 900 (banners at most 2560 wide) and re-saved as a quality JPEG, instead of the full-size original being stored and sent to every visitor. Smaller images and all other uploads (article images, branding, attachments) are stored exactly as uploaded, and if an image can't be processed the original is kept — an upload never fails over sizing. Media files are also cached by browsers for 30 days now (each upload gets a fresh address, so updates still show immediately).

## What's new in 1.2.1

- **Dark mode is now the site default — and the admin decides** — a new **Theme mode** control in Admin → Site & Branding: **Dark only** (the default: every visitor, admin included, sees the dark theme and the visitor theme toggle is hidden), **Light only** (the same, in light), or **Match visitor's device** (the theme toggle returns and each visitor's device preference rules, with the Default theme seeding a first visit). Existing sites pick up Dark only automatically — no setup needed — and a theme a visitor previously chose on their device no longer overrides a forced mode.

## What's new in 1.2.0

- **Categories have a separate page banner** — a category can now carry two different images: the **cover image** (homepage cards and listings, unchanged) and a new **page banner** shown as the wide banner at the top of the category page itself. Set it in Admin → Categories with the same upload / library / clear controls as the cover. Leave the page banner empty and the category page keeps using the cover image, exactly as before — existing categories need no changes.

## What's new in 1.1.5

- **"Your Services" is now a personal, display-only list** — the homepage cards no longer click through to service article lists (no links, no arrows); they simply show the signed-in viewer the services attached to their account, with icon, name and description. The "View All My Services" link next to the section is gone (the All Services page itself still exists in the site navigation, unchanged).
- **Only your own services are listed** — previously the section showed the first two services from the whole catalog; it now shows exactly the services attached to the viewer (all of them, no cap), and a viewer with none sees a clean "No services are attached to your account yet" note instead of other people's services.
- **Admins can attach services to staff accounts — including their own** — Admin → Users → Edit now has the same services multi-select the customer form has. Staff attachments are stored separately from customer assignments and are purely presentational: they drive that staff member's own homepage list, while admin/management views still show every service, and the existing protections are unchanged (you still can't disable or delete your own account).

## What's new in 1.1.4

- **Fixed the category cover Upload button appearing to do nothing** — the cover field (and the branding logo/favicon/hero fields, plus the group/service chip pickers) wrapped the Upload button's `<label>` inside another `<label>`, which is invalid HTML with inconsistent browser behavior; the field wrappers are now plain containers, so the button works the same everywhere.
- **Uploads can no longer fail silently** — the cover field now shows a persistent inline status ("Uploading…", "✓ Uploaded …", or the exact problem in red) next to the field, not just a fleeting toast. And after any attempt, picking the same file again works — previously a retry with the same file was silently ignored.
- **Clear message for iPhone HEIC photos** — HEIC/HEIF photos (the iPhone default) can't be displayed by most web browsers, so instead of the old "File type not allowed" the uploader now explains that and asks for a JPG or PNG version — the check happens instantly, before the file is sent. Oversized files likewise state the actual limit ("uploads are limited to 15 MB per file") instead of "File too large".

## What's new in 1.1.3

- **Category restrictions are group-based only** — categories can no longer be restricted by service; the "Restrict to services" picker and badges are gone from Admin → Categories, and visibility is decided by group restrictions alone (articles keep their own group-based visibility as before). Services themselves are unchanged — still assigned to customers and still used by invites, CSV import and BookStack import. Existing category→service restriction rows from earlier versions are left in the database untouched but are no longer enforced.
- **Service names never stack word-per-line** — following the 1.1.2 chip fix, the remaining service buttons/cards got the same treatment: homepage "Your Services" cards, the All Services / category card titles, and the service chip on article pages now keep icon + name on one line (long names truncate with an ellipsis instead of wrapping), and the services list no longer squeezes its cards into three fixed columns on narrow screens.

## What's new in 1.1.2

- **Fixed picker chips stacking names word-per-line** — the service/group chips in the Invites panel, customer form, and category restrictions now size to their content (icon + full name on one line) and wrap as whole chips instead of squeezing.

## What's new in 1.1.1

- **Version in the footer** — the running app version (from `package.json`, served via the public settings) is shown in the page footer so you can confirm at a glance that you're on the latest release.

## What's new in 1.1.0

- **Customers can belong to multiple groups** — group membership is now many-to-many; a customer sees group-restricted articles for *any* group they belong to. Existing single-group assignments migrate automatically on first boot.
- **Customers can hold multiple services**, assigned from the customer form.
- **Service → group auto-membership** — map a service to a group and everyone holding that service is added to the group automatically (additive only, never removes).
- **Managed invites** — a dedicated Invites section (Admin → Customers): create an invite with name, email and services, track pending / accepted / expired status, copy the invite link any time, and resend. Admins can be notified by **email and/or Discord webhook** when an invite is accepted (Settings → Email).
- **Hex colors everywhere** — every color control (groups, services, categories, branding) shows and stores `#rrggbb`; older `rgb()` values are normalized automatically, no data migration needed.
- **BookStack import now imports users too** — BookStack users become pending customers (no password set); send them a friendly **welcome email** from the Customers list (per-customer button or “Send welcome to pending”) so they can set a password and onboard.
- **CSV import template** — download a ready-made template (Admin → Customers → CSV import → Template CSV); the importer also accepts a **Services** column (semicolon-separated names) alongside the existing per-row Group column.
- **Clean URLs** — the whole app (reader + admin) now uses standard paths (`/article/<slug>`, `/admin/customers`, …) instead of hash routes. Old `#/…` bookmarks and previously emailed links redirect automatically, once.
- **Bigger homepage category tiles** — substantially larger tiles with big icons/titles; categories are now the single browse path (the “Browse by Service” section was removed; “Your Services” remains).
- **Category access control by service and group** — a category can be restricted to customers holding certain services and/or belonging to certain groups (Admin → Categories → edit). Both restrictions compose; staff always see everything; articles inside a restricted category are protected everywhere (home, search, lists, direct links).
- **OneDrive backups fixed — now truly Microsoft end to end** (Microsoft identity platform + Microsoft Graph; the old build produced malformed Graph URLs so OneDrive file operations could never succeed). Google Drive audited alongside.
- **Guided cloud-backup setup wizard** — per provider: 1) create the app (deep link + exact copyable redirect URI), 2) paste the keys (with format checks), 3) one-click Connect with automatic verification — the panel shows the connected account and a **Test connection** probe (account + folder + contents), with plain-language errors (e.g. redirect-URI mismatch, wrong secret).

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

- Admin → BookStack Import: enter the instance URL + API token, test the connection, then import. The connection can be **saved for later imports** — the Token Secret is stored encrypted (AES-256-GCM) and never displayed again; test/import fall back to the saved connection when the fields are left blank, and freshly typed credentials take precedence for that run
- Books → categories, Pages → articles (chapter kept as a tag, page tags + author carried over, drafts stay drafts, HTML formatting preserved); each book's cover image is downloaded into the Media Library and set as the category's cover
- Referenced images and page attachments are downloaded into the Media Library and the content is rewritten to the new hosted paths; links between imported pages are rewired to the new articles
- Progress + completion summary; re-runs are idempotent (skip by default, or update in place) — no duplicates
- **Live import log**: every run writes a timestamped log (books/categories, pages created/updated/skipped, media imported/reused, link rewrites, and any error as it happens) that streams into the tab while the import runs; each finished run is saved, and the **last 3 runs** stay listed under Past imports with their full logs for after-the-fact review

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
