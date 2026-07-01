// Verifies the client-side HEIC→JPEG conversion end to end.
//
// heic2any is loaded on demand (only when isHeic() matches) and decodes the HEIC
// to JPEG in the browser before the canvas downscale. The server stores the
// uploaded file under its original extension (path.extname in routes/api.js), so
// the created photo's filename is a decisive discriminator: `.jpg` proves the
// client conversion ran; a stored `.heic` would prove it did NOT.
//
// Fixture: cypress/fixtures/sample.heic — a real HEVC HEIC (ftyp brand `heic`).

describe('HEIC upload (client-side conversion)', () => {
  beforeEach(() => {
    cy.loginApi(); // session cookie set before the page loads
    cy.visitApp();
    // Already authenticated, so Edit drops straight into edit mode.
    cy.get('#btn-edit-mode').click();
    cy.get('#edit-indicator').should('not.have.class', 'hidden');
  });

  it('loads heic2any, converts to JPEG, and creates a POI with a .jpg photo', () => {
    // Nothing else requests this bundle, and the loader only fires from
    // heicToJpeg() → so a hit proves a HEIC was recognised and routed to convert.
    cy.intercept('GET', '/vendor/heic2any/**').as('heicLib');
    cy.intercept('POST', '/api/upload-photos').as('upload');

    // The input is display:none (triggered by a button in the real UI), so force.
    cy.get('#bulk-file-input').selectFile('cypress/fixtures/sample.heic', { force: true });

    // On-demand load fired.
    cy.wait('@heicLib').its('response.statusCode').should('eq', 200);

    // WASM decode + upload can take a few seconds — allow generous time.
    cy.wait('@upload', { timeout: 40000 }).then(({ response }) => {
      expect(response.statusCode).to.eq(200);
      const pois = response.body.pois;
      expect(pois, 'created POIs').to.have.length.of.at.least(1);
      const photo = pois[0].photos[0];
      expect(photo, 'photo record').to.exist;
      // Decisive: conversion renamed .heic → .jpg; a stored .heic means it didn't run.
      expect(photo.filename.toLowerCase(), 'stored filename').to.match(/\.jpg$/);
      expect(photo.filename.toLowerCase()).to.not.contain('.heic');
    });

    // UI confirms the location was added.
    cy.get('#upload-toast-msg', { timeout: 40000 }).should('contain.text', 'Added');
  });
});
