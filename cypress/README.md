# Cypress e2e tests

End-to-end tests that run against a **live local server** (SQLite + local disk, no AWS).

## Running

### One command (recommended)

`start-server-and-test` boots the server, waits for `http://localhost:3000`,
runs the tests, then shuts the server down:

```bash
npm run test:e2e        # headless
npm run test:e2e:open   # interactive runner
```

### Against an already-running server

If you already have the app running (`npm start`), run the raw Cypress scripts:

```bash
npm run cy:run     # headless
npm run cy:open    # interactive runner
```

## Configuration

`cypress.config.js` reads two optional environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `CYPRESS_BASE_URL` | App URL under test | `http://localhost:3000` |
| `CYPRESS_ADMIN_PASSWORD` | Edit-mode password (must match `ADMIN_PASSWORD` in `.env`) | `changeme` |

The viewport is fixed at 1280×800 so tracking mode does **not** auto-enable
(the app turns it on when `min(width,height) <= 768`).

## What's covered

- **smoke** — page load, Leaflet map, injected `/config.js`, view-mode toolbar state.
- **auth** — login modal, wrong/correct password, cancel, logout.
- **api** — public reads (`/api/pois`, `/api/routes`, `/api/projects`), auth
  enforcement (401 on writes when signed out), and a full POI
  create→read→update→delete lifecycle (self-cleaning).
- **ui** — welcome/help modal, tracking toggle, projects dialog, and the New POI
  dialog opening on a map click (cancelled, so nothing is persisted).

## Notes

- The API lifecycle test creates and then deletes its own POI; the UI tests are
  otherwise non-destructive.
- `cy.visitApp()` (see `support/commands.js`) waits for the loading overlay to
  gain the `hidden` class and suppresses the one-time help modals via
  `localStorage` so they don't cover the UI under test.
