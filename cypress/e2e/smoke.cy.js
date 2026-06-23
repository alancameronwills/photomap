describe('App load (smoke)', () => {
  beforeEach(() => cy.visitApp());

  it('renders the toolbar and map', () => {
    cy.get('#app-title').should('contain.text', 'Map y Ffoto');
    cy.get('#map').should('be.visible');
    // Leaflet attaches its container class once the map is constructed.
    cy.get('#map').should('have.class', 'leaflet-container');
    cy.get('.leaflet-tile-pane').should('exist');
  });

  it('serves the injected client config', () => {
    cy.request('/config.js').then((res) => {
      expect(res.headers['content-type']).to.match(/javascript/);
      expect(res.body).to.contain('window.APP_CONFIG');
    });
  });

  it('shows the view-mode toolbar buttons and hides edit-only ones', () => {
    cy.get('#btn-edit-mode').should('be.visible');
    cy.get('#btn-tracking').should('be.visible');
    cy.get('#btn-help').should('be.visible');
    // Edit-only buttons start hidden until edit mode is entered.
    cy.get('#btn-bulk-upload').should('have.class', 'hidden');
    cy.get('#btn-import-gpx').should('have.class', 'hidden');
    cy.get('#btn-logout').should('have.class', 'hidden');
  });

  it('starts in view mode (no edit indicator)', () => {
    cy.get('#edit-indicator').should('have.class', 'hidden');
    cy.get('#route-edit-indicator').should('have.class', 'hidden');
  });
});
