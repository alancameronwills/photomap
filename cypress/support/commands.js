// Custom commands shared across PhotoMap specs.

// Suppress the one-time help/welcome modals so they don't cover the UI under
// test. app.js gates them on these localStorage flags (see maybeShowHelp).
// Call inside cy.visit's onBeforeLoad.
export function silenceHelp(win) {
  win.localStorage.setItem('helpSeen_welcome', '1');
  win.localStorage.setItem('helpSeen_edit', '1');
}

// Visit the app and wait for the startup Promise.all to clear the loading
// overlay (it removes itself from the DOM). Pass { help: true } to allow the
// welcome modal (used by the help-specific test).
Cypress.Commands.add('visitApp', (opts = {}) => {
  cy.visit('/', {
    onBeforeLoad(win) {
      if (!opts.help) silenceHelp(win);
    },
  });
  // Once startup data has loaded the overlay gets the `hidden` class
  // (opacity:0; pointer-events:none) and then removes itself on transitionend.
  // The class is the reliable signal — the transitionend removal doesn't fire
  // in headless runs, but pointer-events:none means it no longer blocks the UI.
  cy.get('#loading-overlay', { timeout: 15000 }).should('have.class', 'hidden');
});

// Authenticate at the API level so the session cookie is set for both cy.request
// calls and the next page load. Mirrors POST /auth/login.
Cypress.Commands.add('loginApi', () => {
  cy.request('POST', '/auth/login', {
    password: Cypress.env('adminPassword'),
  }).its('status').should('eq', 200);
});
