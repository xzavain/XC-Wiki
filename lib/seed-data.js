'use strict';
/* Seed content for XC Wiki: categories, services, tags, articles. */

function seedArticles() {
  return [
    {
      title: 'How do I accept my Media Share invite?',
      slug: 'accept-media-share-invite',
      category: 'Getting Started', service: 'Media Share',
      tags: ['invite', 'getting started', 'email'],
      featured: 1, pinned: 1,
      content_md: `## Accepting your invite

When your Media Share is provisioned, an invitation email is sent to the address on your XC account. Accepting it links the share to your media apps.

### Steps

1. Open the inbox for the email on your XC account.
2. Find the message with the subject **"You've been invited to a Media Share"**.
3. Click **Accept Invite**. This opens the Media Share web app.
4. Sign in with your XC account credentials if prompted.
5. You should now see the shared libraries on your home screen.

> **Tip:** Invites expire after **72 hours**. If your link expired, open a support ticket and we will re-send it free of charge.

### What to do next

- [Finding Your Media Share Login Information](/article/media-share-login-information)
- [Backing Up Your Watch History](/article/backing-up-watch-history)

### Still stuck?

If the invite link shows an error, make sure you are signed in with the **same email** that received the invite. Corporate forwarding addresses and aliases will not work.`,
    },
    {
      title: 'Finding Your XC Share Login Information',
      slug: 'xc-share-login-information',
      category: 'Getting Started', service: 'XC Share',
      tags: ['login', 'credentials', 'getting started'],
      featured: 1,
      content_md: `## Where your login lives

Your XC Share credentials are generated automatically when the service is provisioned. They are **not** the same as your XC account login.

### Finding them

1. Log in to the [XC Wiki dashboard](/).
2. Go to **Your Services** and click **XC Share**.
3. Open the **Login Information** tab.
4. Your username is shown in plain text; click the eye icon to reveal the password.

### Resetting the password

If you have lost access:

1. Open the XC Share card and click **Reset Password**.
2. A new password is generated instantly.
3. Update any apps or clients that used the old password — they will stop working until you do.

\`\`\`
# Example: testing your login with curl
curl -u "USERNAME:PASSWORD" https://share.xc.example/api/health
\`\`\`

> **Security note:** Never share your XC Share password in public chats. Staff will never ask for it.`,
    },
    {
      title: 'XC Share Quick Start',
      slug: 'xc-share-quick-start',
      category: 'Getting Started', service: 'XC Share',
      tags: ['quick start', 'setup'],
      content_md: `## Get running in 5 minutes

This guide takes you from a fresh XC Share to your first uploaded file.

### 1. Log in

Use the credentials from [Finding Your XC Share Login Information](/article/xc-share-login-information).

### 2. Create your first folder

Click **New Folder**, name it \`media\`, and open it.

### 3. Upload a file

Drag and drop any file into the browser window. Uploads resume automatically if your connection drops.

### 4. Share a link

Right-click the file → **Share** → copy the link. You can set an expiry date and an optional password.

### Limits

| Plan | Storage | Max file size |
|------|---------|---------------|
| Starter | 250 GB | 10 GB |
| Plus | 1 TB | 50 GB |
| Pro | 4 TB | 200 GB |`,
    },
    {
      title: 'Why is my Media Share stuck on "Starting"?',
      slug: 'media-share-stuck-starting',
      category: 'Troubleshooting', service: 'Media Share',
      tags: ['troubleshooting', 'startup', 'stuck'],
      featured: 1,
      content_md: `## The short version

A share stuck on **Starting** for more than 10 minutes almost always means the media scanner is still indexing a large library, or the app container failed its health check.

### Check the status page first

Before anything else, check the [XC status page](https://status.xc.example). If there is an active incident, sit tight — no action is needed on your end.

### If no incident is active

1. Open your Media Share and click **Restart** under the power menu.
2. Wait 5 minutes and refresh.
3. Still stuck? Open the **Logs** tab and look for lines containing \`ERROR\`.

### Common log messages

\`\`\`
# Database locked — the scanner is still running. Wait it out.
[ERROR] database is locked (retry 12/20)

# Out of disk — free space or upgrade your plan.
[ERROR] no space left on device
\`\`\`

### When to contact support

Contact support if the share has been stuck for **over 30 minutes** after a restart. Include:
- Your service username
- The last 50 lines of the log
- When the problem started`,
    },
    {
      title: 'Backing Up Your Watch History',
      slug: 'backing-up-watch-history',
      category: 'Setup Guides', service: 'Media Share',
      tags: ['backup', 'watch history'],
      content_md: `## Why back it up?

Your watch history, ratings, and playlists live in the Media Share database. If you ever migrate services, a backup lets you restore everything exactly as it was.

### Automatic backups

XC takes a nightly snapshot of every Media Share automatically and keeps **7 days** of history. You don't need to do anything.

### Manual backup

1. Open Media Share → **Settings** → **Backups**.
2. Click **Create Backup Now**.
3. Download the \`.zip\` when it finishes.

### Restoring

1. Go to **Settings** → **Backups** → **Restore**.
2. Upload a backup \`.zip\` (automatic or manual).
3. The share restarts and your history is restored.

> Restoring replaces **all** current data. Export anything new first if it matters to you.`,
    },
    {
      title: 'AppBox First Boot Guide',
      slug: 'appbox-first-boot',
      category: 'Setup Guides', service: 'XC AppBox',
      tags: ['appbox', 'first boot', 'setup'],
      content_md: `## First boot walkthrough

Your XC AppBox boots to a setup wizard the first time it comes online. The whole process takes about 3 minutes.

### Wizard steps

1. **Admin account** — create the administrator username and password. This is separate from your XC account.
2. **Apps** — tick the apps you want installed now. You can add more later from the app store.
3. **Storage** — choose the default download location.
4. **Done** — the AppBox installs your selections and reboots once.

### After the reboot

Open \`http://<your-appbox-ip>:8080\` and sign in with the admin account you just created. Install additional apps from **App Store** in the sidebar.

### Default ports

| App | Port |
|-----|------|
| Dashboard | 8080 |
| Downloads | 8081 |
| Media | 8096 |`,
    },
    {
      title: 'AppBox Ports Explained',
      slug: 'appbox-ports',
      category: 'Setup Guides', service: 'XC AppBox',
      tags: ['appbox', 'ports', 'networking'],
      content_md: `## Which port does what?

Every app on your XC AppBox listens on its own port. You only need these if you are connecting directly or setting up reverse proxies.

### Core ports

- **8080** — Main dashboard
- **8081** — Download client web UI
- **8096** — Media server
- **8686** — TV automation
- **7878** — Movie automation

### Changing a port

1. Stop the app from the dashboard.
2. Edit the app's settings → **Network** → change the port.
3. Start the app again.

> Ports below 1024 are reserved. Pick something between **1025 and 65535**.

### Remote access

Don't expose these ports directly to the internet. Use the built-in **Remote Access** toggle, which provisions an HTTPS URL with authentication.`,
    },
    {
      title: 'How do I view my XC service information?',
      slug: 'view-xc-service-information',
      category: 'FAQs', service: null,
      tags: ['faq', 'account'],
      content_md: `## Quick answer

Log in to your XC account, open **Your Services**, and click any service card. You'll see its status, plan, renewal date, login credentials, and quick actions.

### What you can see per service

- **Status** — Online, Starting, or Suspended
- **Plan & renewal** — current plan and next billing date
- **Login information** — usernames and password reset
- **Quick actions** — restart, reinstall, open web UI

### Can I see other people's services?

No. You only see services owned by your XC account. Reseller accounts see their clients' services under a separate **Clients** tab.`,
    },
    {
      title: 'How do I find my Stream Share login information?',
      slug: 'stream-share-login-information',
      category: 'Getting Started', service: 'Stream Share',
      tags: ['login', 'stream share'],
      content_md: `## Finding your credentials

1. Log in to your XC account.
2. Open **Your Services** → **Stream Share**.
3. Click the **Login Information** tab.

Your Stream Share username is your XC account email. The password is generated for you — click the eye icon to reveal it, or **Reset Password** to generate a new one.

### Using the credentials

Enter them in any compatible streaming app when it asks for server login details. The server address is shown on the same tab and looks like:

\`\`\`
https://stream-XXXX.xc.example
\`\`\`

### Locked out?

Too many failed attempts temporarily locks logins for 15 minutes. Wait it out, or reset the password to unlock immediately.`,
    },
    {
      title: 'Dedicated Server: Setting Your Library Path',
      slug: 'dedicated-server-library-path',
      category: 'Setup Guides', service: 'XC Dedicated',
      tags: ['dedicated', 'library', 'paths'],
      content_md: `## Library paths on dedicated servers

Unlike shared services, your dedicated server gives you full control over where media lives. Apps only see what you tell them to see.

### Recommended layout

\`\`\`
/mnt/storage/
├── media/
│   ├── movies/
│   ├── tv/
│   └── music/
└── downloads/
    ├── complete/
    └── incomplete/
\`\`\`

### Pointing apps at it

1. Open the app's web UI (e.g., media server on port 8096).
2. Go to **Settings** → **Libraries** → **Add Library**.
3. Browse to \`/mnt/storage/media/movies\` (or your chosen path).
4. Save and let the initial scan finish.

### Permissions

If an app can't see your files, it's almost always permissions. Files should be owned by the app user:

\`\`\`bash
sudo chown -R apps:apps /mnt/storage/media
sudo chmod -R 755 /mnt/storage/media
\`\`\``,
    },
    {
      title: 'Dedicated Server Access Guide',
      slug: 'dedicated-server-access',
      category: 'Setup Guides', service: 'XC Dedicated',
      tags: ['dedicated', 'ssh', 'access'],
      content_md: `## Connecting to your server

### SSH (recommended)

Your server's IP, username, and SSH port are on the **Login Information** tab of your XC Dedicated service card.

\`\`\`bash
ssh -p 2222 xcuser@203.0.113.10
\`\`\`

### Web terminal

No SSH client handy? Use the **Web Terminal** button on the service card for an in-browser shell. It supports copy/paste and full terminal colors.

### First-login checklist

- [ ] Change the default password: \`passwd\`
- [ ] Add your SSH key: paste it into \`~/.ssh/authorized_keys\`
- [ ] Enable automatic security updates
- [ ] Set up backups (see [Backing Up Your Watch History](/article/backing-up-watch-history))

### Root access

Root login over SSH is disabled. Use \`sudo -i\` after connecting as your service user.`,
    },
    {
      title: 'Understanding Your XC Invoice',
      slug: 'understanding-your-invoice',
      category: 'Account & Billing', service: null,
      tags: ['billing', 'invoice'],
      content_md: `## Reading your invoice

Invoices are generated on your billing date and emailed as PDF. You can also download them any time from **Account → Billing → Invoices**.

### Line items

- **Service plan** — the base price of each active service
- **Add-ons** — extra storage, backup retention, etc.
- **Prorations** — partial-period charges when you upgrade mid-cycle
- **Credits** — courtesy credits or referral rewards applied

### Proration example

Upgrading from Starter ($10/mo) to Plus ($20/mo) halfway through the month:

\`\`\`
Unused Starter time:  -$5.00 (credit)
Plus remainder:      +$10.00 (charge)
Net on next invoice:  +$5.00
\`\`\`

### Failed payments

If a payment fails, we retry automatically after 24 and 72 hours. Your services keep running during the retry window. After the third failure the account is suspended — update your payment method to restore service instantly.`,
    },
    {
      title: 'How to Update Your Payment Method',
      slug: 'update-payment-method',
      category: 'Account & Billing', service: null,
      tags: ['billing', 'payment'],
      content_md: `## Updating your card

1. Log in → **Account** → **Billing**.
2. Click **Update Payment Method**.
3. Enter the new card details and save.

The new method is used for the next scheduled charge. Any currently past-due balance is charged immediately.

### Supported methods

- Visa, Mastercard, Amex, Discover
- SEPA direct debit (EU accounts)

### Why did my card get declined?

The most common reasons:
- Expired card on file
- Bank blocking the merchant — call the number on the back of your card
- Insufficient funds or daily limit reached

After updating, click **Retry Payment** on any outstanding invoice.`,
    },
    {
      title: "Server Won't Start? Read This First",
      slug: 'server-wont-start',
      category: 'Troubleshooting', service: null,
      tags: ['troubleshooting', 'startup'],
      featured: 1,
      content_md: `## Before you panic

Nine times out of ten, a server that won't start is one of three things: an expired plan, a stuck update, or a full disk. This checklist covers all three in under 5 minutes.

### 1. Check your plan status

Suspended accounts can't start services. Go to **Account → Billing** and confirm your plan is active and paid up.

### 2. Check for a stuck update

Open the service card → **Activity**. If an update has been "in progress" for over 30 minutes:

1. Click **Cancel Update**.
2. Click **Restart**.
3. Wait 5 minutes.

### 3. Check disk space

Open the service card → **Metrics**. If disk usage is above 95%:

- Delete old downloads or clear the trash
- Upgrade storage from the service card

### Still down?

Grab the last 50 lines of the log (**Logs** tab) and open a support ticket. Include what you already tried — it gets you a faster answer.`,
    },
    {
      title: 'Port Forwarding for Remote Access',
      slug: 'port-forwarding-remote-access',
      category: 'Troubleshooting', service: 'XC Dedicated',
      tags: ['networking', 'port forward', 'remote'],
      content_md: `## Do you actually need this?

For most XC services: **no**. Use the built-in **Remote Access** toggle instead — it gives you an HTTPS URL with zero router configuration.

### When manual forwarding is needed

Only dedicated servers with custom apps outside our dashboard need manual port forwarding, and only if your server sits behind NAT (most home-hosted setups — not XC-hosted servers, which have public IPs).

### The basics

1. Give the device a **static LAN IP** (e.g., \`192.168.1.50\`).
2. In your router, forward the app's port (e.g., \`8096\`) to that IP, TCP.
3. Test from your phone with Wi-Fi **off**: \`http://<your-public-ip>:8096\`.

### Safer alternative: reverse proxy

Instead of exposing ports, run a reverse proxy with HTTPS:

\`\`\`nginx
server {
    listen 443 ssl;
    server_name media.example.com;
    location / {
        proxy_pass http://192.168.1.50:8096;
    }
}
\`\`\`

This keeps one port (443) open instead of many.`,
    },
    {
      title: 'Scheduled Maintenance — October 2026',
      slug: 'maintenance-october-2026',
      category: 'Announcements', service: null,
      tags: ['maintenance', 'announcement'],
      content_md: `## Planned maintenance window

**Date:** Sunday, October 25, 2026
**Window:** 02:00 – 06:00 UTC
**Expected impact:** Brief interruptions (under 10 minutes per service)

### What's happening

We are upgrading the storage cluster that backs XC Share and Media Share. During the window, services will be restarted one at a time.

### What you should do

Nothing. The upgrades are rolling and automatic. If you notice a brief disconnect, just refresh — no data will be lost.

### Staying informed

- Live updates during the window: [status.xc.example](https://status.xc.example)
- This article will be updated when the work completes.`,
    },
    {
      title: 'New Feature: One-Click Backups',
      slug: 'one-click-backups',
      category: 'Announcements', service: null,
      tags: ['feature', 'backup', 'announcement'],
      featured: 1,
      content_md: `## Backups, minus the hassle

You can now create a full backup of any XC service with one click — no SSH, no commands, no scheduling required.

### How it works

1. Open any service card.
2. Click **Back Up Now**.
3. Download the snapshot when it finishes, or let us keep it: we retain the last **7 automatic snapshots** free.

### What's included

- Application database (libraries, watch history, settings)
- Uploaded configuration files
- The backup is encrypted at rest with your account key

### Coming next

Scheduled off-site copies to your own S3-compatible storage are in testing and will roll out next month.`,
    },
    {
      title: 'What is the Fair Use Policy?',
      slug: 'fair-use-policy',
      category: 'FAQs', service: null,
      tags: ['faq', 'policy'],
      content_md: `## The plain-English version

"Unlimited" plans are for normal personal use. The Fair Use Policy exists to stop a handful of accounts from degrading the service for everyone else.

### What counts as normal?

- Streaming to your household
- Sharing with a reasonable number of friends and family
- Automated downloads at a normal pace

### What triggers a review?

- Sustained 24/7 maximum-bandwidth usage for weeks
- Reselling access to your service
- Running public indexers or trackers on shared infrastructure

### What happens if I'm flagged?

First, we reach out — most cases are resolved with a conversation. Only repeated, deliberate abuse after warnings leads to throttling or suspension. We have never suspended an account without at least two prior warnings.`,
    },
  ];
}

function seedMeta() {
  return {
    categories: [
      { name: 'Getting Started', slug: 'getting-started', description: "New to XC? Start here.", icon: '🚀', color: '#3B82F6', sort_order: 1 },
      { name: 'Setup Guides', slug: 'setup-guides', description: 'Step-by-step instructions', icon: '📋', color: '#8B5CF6', sort_order: 2 },
      { name: 'Troubleshooting', slug: 'troubleshooting', description: 'Fix common issues', icon: '🔧', color: '#F59E0B', sort_order: 3 },
      { name: 'FAQs', slug: 'faqs', description: 'Quick answers', icon: '❓', color: '#10B981', sort_order: 4 },
      { name: 'Account & Billing', slug: 'account-billing', description: 'Manage your account', icon: '💳', color: '#EC4899', sort_order: 5 },
      { name: 'Announcements', slug: 'announcements', description: 'Latest updates', icon: '📢', color: '#06B6D4', sort_order: 6 },
    ],
    services: [
      { name: 'XC Share', slug: 'xc-share', description: 'Everything you need to set up and use your XC Share.', icon: '📦', color: '#8B5CF6', sort_order: 1 },
      { name: 'Media Share', slug: 'media-share', description: 'Everything you need to set up and use your Media Share.', icon: '🎬', color: '#10B981', sort_order: 2 },
      { name: 'Stream Share', slug: 'stream-share', description: 'Live streaming made simple.', icon: '📡', color: '#3B82F6', sort_order: 3 },
      { name: 'XC AppBox', slug: 'xc-appbox', description: 'Your personal app server.', icon: '📱', color: '#F59E0B', sort_order: 4 },
      { name: 'Media AppBox', slug: 'media-appbox', description: 'Media apps, pre-installed.', icon: '🎞️', color: '#06B6D4', sort_order: 5 },
      { name: 'XC Dedicated', slug: 'xc-dedicated', description: 'Full power, full control.', icon: '🖥️', color: '#6366F1', sort_order: 6 },
      { name: 'XC Reseller', slug: 'xc-reseller', description: 'Grow your own hosting business.', icon: '🤝', color: '#EC4899', sort_order: 7 },
      { name: 'XC Backup', slug: 'xc-backup', description: 'Automatic off-site backups.', icon: '💾', color: '#F59E0B', sort_order: 8 },
    ],
  };
}

module.exports = { seedArticles, seedMeta };
