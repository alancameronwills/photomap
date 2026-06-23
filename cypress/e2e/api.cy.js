// Exercises the HTTP API directly via cy.request. cy.request shares a cookie
// jar within a test, so loginApi() authenticates subsequent write calls.

describe('API — public reads', () => {
  it('reports unauthenticated status before login', () => {
    cy.request('/auth/status').its('body').should('deep.include', {
      authenticated: false,
    });
  });

  it('lists POIs without auth', () => {
    cy.request('/api/pois').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.be.an('array');
    });
  });

  it('lists routes without auth', () => {
    cy.request('/api/routes').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.be.an('array');
    });
  });

  it('returns projects with a default id', () => {
    cy.request('/api/projects').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.projects).to.be.an('array');
      expect(res.body).to.have.property('defaultId');
    });
  });

  it('404s for an unknown POI', () => {
    cy.request({ url: '/api/pois/99999999', failOnStatusCode: false })
      .its('status')
      .should('eq', 404);
  });
});

describe('API — auth enforcement', () => {
  it('rejects a wrong password with 401', () => {
    cy.request({
      method: 'POST',
      url: '/auth/login',
      body: { password: 'nope-wrong' },
      failOnStatusCode: false,
    }).its('status').should('eq', 401);
  });

  it('blocks POI creation when signed out', () => {
    cy.request({
      method: 'POST',
      url: '/api/pois',
      body: { lat: 51.5, lng: -0.1, title: 'should fail' },
      failOnStatusCode: false,
    }).its('status').should('eq', 401);
  });

  it('blocks POI deletion when signed out', () => {
    cy.request({
      method: 'DELETE',
      url: '/api/pois/1',
      failOnStatusCode: false,
    }).its('status').should('eq', 401);
  });
});

describe('API — POI lifecycle (authenticated)', () => {
  beforeEach(() => cy.loginApi());

  it('creates, reads, updates and deletes a POI', () => {
    // Create
    cy.request('POST', '/api/pois', {
      lat: 51.501,
      lng: -0.142,
      title: 'Cypress POI',
      note: 'created by test',
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('id');
      const id = res.body.id;

      // Read back
      cy.request(`/api/pois/${id}`).its('body').should((poi) => {
        expect(poi.title).to.eq('Cypress POI');
        expect(poi.photos).to.be.an('array');
      });

      // Update
      cy.request('PUT', `/api/pois/${id}`, {
        title: 'Cypress POI (edited)',
        note: 'updated by test',
      }).its('body.title').should('eq', 'Cypress POI (edited)');

      // Delete (returns cascade info)
      cy.request('DELETE', `/api/pois/${id}`).then((del) => {
        expect(del.status).to.eq(200);
        expect(del.body).to.have.property('ok', true);
        expect(del.body).to.have.property('deletedNodeIds');
      });

      // Gone
      cy.request({ url: `/api/pois/${id}`, failOnStatusCode: false })
        .its('status')
        .should('eq', 404);
    });
  });

  it('rejects a POI with missing coordinates', () => {
    cy.request({
      method: 'POST',
      url: '/api/pois',
      body: { title: 'no coords' },
      failOnStatusCode: false,
    }).its('status').should('eq', 400);
  });
});
