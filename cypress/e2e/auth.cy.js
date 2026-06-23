describe('Edit-mode authentication', () => {
  beforeEach(() => cy.visitApp());

  it('opens the login modal when Edit is clicked while signed out', () => {
    cy.get('#login-overlay').should('have.class', 'hidden');
    cy.get('#btn-edit-mode').click();
    cy.get('#login-overlay').should('not.have.class', 'hidden');
    cy.get('#login-password').should('be.visible');
  });

  it('rejects a wrong password and shows the error', () => {
    cy.get('#btn-edit-mode').click();
    cy.get('#login-password').type('definitely-wrong-password');
    cy.get('#btn-login-submit').click();
    cy.get('#login-error').should('not.have.class', 'hidden');
    // Still signed out: stay on the login modal, no edit indicator.
    cy.get('#login-overlay').should('not.have.class', 'hidden');
    cy.get('#edit-indicator').should('have.class', 'hidden');
  });

  it('signs in with the correct password and enters edit mode', () => {
    cy.get('#btn-edit-mode').click();
    cy.get('#login-password').type(Cypress.env('adminPassword'));
    cy.get('#btn-login-submit').click();

    cy.get('#login-overlay').should('have.class', 'hidden');
    cy.get('#edit-indicator').should('not.have.class', 'hidden');
    // Edit-only toolbar buttons become available.
    cy.get('#btn-bulk-upload').should('not.have.class', 'hidden');
    cy.get('#btn-import-gpx').should('not.have.class', 'hidden');
    cy.get('#btn-logout').should('not.have.class', 'hidden');
  });

  it('cancel dismisses the login modal without signing in', () => {
    cy.get('#btn-edit-mode').click();
    cy.get('#btn-login-cancel').click();
    cy.get('#login-overlay').should('have.class', 'hidden');
    cy.get('#edit-indicator').should('have.class', 'hidden');
  });

  it('logs out and returns to view mode', () => {
    // Sign in first.
    cy.get('#btn-edit-mode').click();
    cy.get('#login-password').type(Cypress.env('adminPassword'));
    cy.get('#btn-login-submit').click();
    cy.get('#btn-logout').should('not.have.class', 'hidden').click();

    cy.get('#edit-indicator').should('have.class', 'hidden');
    cy.get('#btn-logout').should('have.class', 'hidden');
  });
});
