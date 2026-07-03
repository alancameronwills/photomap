describe('Help / welcome modal', () => {
  it('auto-shows the welcome modal on first visit', () => {
    // Allow the welcome modal (don't set the helpSeen flags).
    cy.visitApp({ help: true });
    cy.get('#help-overlay').should('not.have.class', 'hidden');
    cy.get('#help-title').should('contain.text', 'Welcome');
    cy.get('#btn-help-ok').click();
    cy.get('#help-overlay').should('have.class', 'hidden');
  });

  it('reopens via the toolbar ? button', () => {
    cy.visitApp(); // help suppressed
    cy.get('#help-overlay').should('have.class', 'hidden');
    cy.get('#btn-help').click();
    cy.get('#help-overlay').should('not.have.class', 'hidden');
    cy.get('#help-close').click();
    cy.get('#help-overlay').should('have.class', 'hidden');
  });
});

describe('Tracking mode', () => {
  beforeEach(() => cy.visitApp());

  it('toggles the crosshair on and off (desktop starts off)', () => {
    cy.get('#crosshair').should('have.class', 'hidden');
    cy.get('#btn-tracking').click();
    cy.get('#btn-tracking').should('have.class', 'active');
    cy.get('#crosshair').should('not.have.class', 'hidden');
    // The tracking-panel only un-hides once a POI is under the crosshair, which
    // is data-dependent — so we don't assert on it here.

    cy.get('#btn-tracking').click();
    cy.get('#btn-tracking').should('not.have.class', 'active');
    cy.get('#crosshair').should('have.class', 'hidden');
  });
});

describe('Projects dialog', () => {
  beforeEach(() => cy.visitApp());

  it('opens and closes the project list', () => {
    cy.get('#project-overlay').should('have.class', 'hidden');
    cy.get('#btn-project').click();
    cy.get('#project-overlay').should('not.have.class', 'hidden');
    cy.get('#project-list li').should('have.length.at.least', 1);
    cy.get('#btn-project-close').click();
    cy.get('#project-overlay').should('have.class', 'hidden');
  });

  it('hides the new-project row when signed out', () => {
    cy.get('#btn-project').click();
    cy.get('#project-new').should('have.class', 'hidden');
  });
});

describe('New POI dialog (signed in)', () => {
  beforeEach(() => {
    cy.loginApi(); // session cookie set before the page loads
    // Park the view over empty ground (mid-Wales, no POIs) so the centre click
    // lands on the map itself rather than an existing marker — otherwise the map
    // fits to all POIs and a marker sits under the crosshair.
    cy.visitApp({ mapView: { lat: 52.5, lng: -3.0, zoom: 13 } });
    // Already authenticated, so Edit drops straight into edit mode.
    cy.get('#btn-edit-mode').click();
    cy.get('#edit-indicator').should('not.have.class', 'hidden');
  });

  it('opens the New POI dialog when the map is clicked, and cancels cleanly', () => {
    cy.get('#new-poi-overlay').should('have.class', 'hidden');
    // Click the centre of the map container to drop a point.
    cy.get('#map').click(640, 400);
    cy.get('#new-poi-overlay').should('not.have.class', 'hidden');
    cy.get('#new-title-input').type('Discarded test POI');
    // Cancel without saving — leaves the database untouched.
    cy.get('#btn-new-cancel').click();
    cy.get('#new-poi-overlay').should('have.class', 'hidden');
  });
});
