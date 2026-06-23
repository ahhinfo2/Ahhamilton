# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AHH (Association Haïtienne de Hamilton) — a full-stack community management platform. French-language app for a Haitian community association in Hamilton, Ontario. Single-page dashboard (vanilla JS, no framework), Express backend, SQLite database.

## Commands

```bash
# Start development server (port 3001)
node server.js

# Syntax check (no test suite exists)
node -c server.js
node -c db/database.js
node -c dashboard/dashboard.js
node -c script.js
node -c _nav.js

# Production deployment
cd /var/www/ahhamilton && git pull && pm2 restart ahhamilton

# Production DB path (different from local!)
# Local: $LOCALAPPDATA/ahh-hamilton/ahh.db or $HOME/ahh-hamilton/ahh.db
# Production: /home/ahh-hamilton/ahh.db (set via DB_PATH env var)
```

## Architecture

### Backend (server.js ~7700 lines)
- Express on port 3001. All API routes under `/api/`.
- Auth: JWT via `middleware/auth.js`. Token accepted from `Authorization: Bearer` header OR `?token=` query param.
- Roles: `admin`, `tresoriere`, `secretaire`, `delegue`, `member`. EXEC = first four.
- `authMiddleware` verifies JWT. `requireRole(...roles)` checks role.
- Mailer: `mailer.js` — nodemailer for transactional emails, IMAP for reading.
- File uploads: multer with multiple storage configs (profiles, activities, payments, forms, documents).
- Cron jobs: `node-cron` for renewals, birthday emails, monthly reports, daily backups.
- Stripe webhooks at `POST /api/stripe-webhook` (raw body parser).
- QR generation: `qrcode` library. Barcode generation: `bwip-js`.
- Image compression: `jimp` via `compressImage()` helper on upload endpoints.

### Database (db/database.js ~1100 lines)
- SQLite via `node-sqlite3-wasm` with a compatibility wrapper (`wrapStmt`) that normalizes variadics.
- Migrations use `try { db.exec('ALTER TABLE ...') } catch {}` pattern — idempotent, no migration framework.
- DB path controlled by `DB_PATH` env var. Production uses `/home/ahh-hamilton/ahh.db`.
- ~40+ tables: users, activities, tickets, payments, meeting_notes, forms, scan_delegations, etc.

### Frontend — Dashboard (dashboard/dashboard.js ~14000 lines)
- Single vanilla JS file. No build step, no framework.
- Globals: `USER` (current user object), `TOKEN` (JWT string from `localStorage.getItem('ahh_token')`), `API` (base URL), `BASE` (origin).
- Navigation: `showView(viewId)` dispatches to view functions via `views` and `extViews` objects.
- Sidebar: `buildSidebar()` (async) — renders different menus for member vs committee roles.
- Content rendering: `setContent(html)` replaces `#mainContent` innerHTML.
- Modals: `openModal(title, bodyHtml)` / `closeModal()` — renders inline, not overlay.
- API calls: `api(endpoint, options)` — wrapper around fetch with auth header.
- Helpers: `escHtml()`, `fmt()` (date), `pill()`, `statusPill()`, `toast()`.
- Permission checks: `can.admin()`, `can.executive()`, `can.adminOrSec()`, etc.

### Frontend — Public Site
- `index.html` — home page with hero, stats, sections.
- `_nav.js` — injects navbar + footer on all public pages. Contains translations dict.
- `_lang.js` — extended translations (FR/EN/HT Creole).
- `script.js` — scroll animations, counters, carousel, lightbox, dark mode, chatbot widget.
- `style.css` — all public page styles. CSS variables in `:root`.
- `sw.js` — service worker for PWA caching.

## Critical Patterns & Pitfalls

### NEVER use JSON.stringify(largeData) in onclick attributes
This was the root cause of a major corruption bug. Large objects (activities, users) serialized into HTML onclick attributes polluted the page rendering. Instead:
```javascript
// BAD — causes visible JSON garbage on page
onclick='openForm(${JSON.stringify(allActs)})'

// GOOD — store in global, reference by name
window._myData = allActs;
// then in HTML:
onclick="openForm(window._myData)"
```

### TDZ (Temporal Dead Zone) prevention
Variables used by `setContent()` (called early via `init()`) must be declared at the top of dashboard.js (before line 20). Variables declared later with `let` will cause a ReferenceError that blanks the entire dashboard.

### Token variable naming
The JWT is stored as `localStorage.getItem('ahh_token')` — NOT `localStorage.getItem('token')`. The global `TOKEN` variable is loaded at init. Always use `TOKEN` in code, never re-read from localStorage.

### Production DB path mismatch
CLI commands on the production server use `/root/ahh-hamilton/ahh.db` by default, but the PM2 process uses `DB_PATH=/home/ahh-hamilton/ahh.db`. Always prefix production DB commands with:
```bash
DB_PATH=/home/ahh-hamilton/ahh.db node -e "..."
```

### Service worker caching
`sw.js` caches API responses aggressively. After deploying changes, bump the cache version in sw.js (`CACHE = 'ahh-vXX'`). If users see stale data, have them run in browser console:
```javascript
caches.keys().then(k=>k.forEach(n=>caches.delete(n)));navigator.serviceWorker.getRegistrations().then(r=>r.forEach(s=>s.unregister()));location.reload(true)
```

### Scan delegation system
`POST /api/tickets/checkin` and `/api/carte-scan/*` endpoints do NOT use `requireRole()`. They check EXEC role inline, then fall back to checking `scan_delegations` table for delegated members. Do not add `requireRole()` back.

### closeModal() navigates away
`closeModal()` calls `showView(returnViewId)` which replaces all page content. Never call `closeModal()` before `openModal()` in the same function — it will navigate to home first.

## Adding a New Feature

### New database table
Add to `db/database.js` using `try { db.exec('CREATE TABLE IF NOT EXISTS ...') } catch {}`.

### New API endpoint
Add to `server.js` BEFORE the 404 handler at the bottom. Use `authMiddleware` + `requireRole()` as needed.

### New dashboard view
1. Create `async function myView() { ... }` that calls `setContent(html)`.
2. Register in `extViews` object (~line 880): `'my-view': myView,`
3. Add sidebar entry in `buildSidebar()` (~line 288): `{ id:'my-view', icon:'X', label:'My View', roles:EXEC }`
4. Add label in `viewLabels` (~line 490): `'my-view':'My View'`

### New public page
Create `mypage.html` at project root. Include `<script src="_lang.js"></script>` and `<script src="_nav.js"></script>` for navbar/footer injection.
