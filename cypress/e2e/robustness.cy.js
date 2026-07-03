// Robustness / hardening checks: the server should always answer the API with
// JSON (never Express's default HTML error page) and should reject malformed or
// oversized input cleanly rather than 500-ing.

describe('Error handling — always JSON', () => {
  it('returns a JSON 400 for a malformed JSON body', () => {
    cy.request({
      method: 'POST',
      url: '/api/pois',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
      expect(res.headers['content-type']).to.match(/application\/json/);
      expect(res.body).to.have.property('error');
    });
  });

  it('returns a JSON error for an oversized body (before auth/routing)', () => {
    // Body parsing happens before the route runs, so this rejects at the
    // express.json stage regardless of auth.
    const big = 'x'.repeat(6 * 1024 * 1024); // > 5mb limit
    cy.request({
      method: 'POST',
      url: '/api/pois',
      body: { lat: 51.5, lng: -0.1, note: big },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(413);
      expect(res.body).to.have.property('error');
    });
  });
});

describe('Input validation (authenticated)', () => {
  beforeEach(() => cy.loginApi());

  it('rejects a non-numeric latitude with 400', () => {
    cy.request({
      method: 'POST',
      url: '/api/pois',
      body: { lat: 'not-a-number', lng: -0.1 },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(400);
      expect(res.body).to.have.property('error');
    });
  });

  it('accepts a genuine zero coordinate (equator/prime meridian)', () => {
    cy.request('POST', '/api/pois', { lat: 0, lng: 0, title: 'null island' })
      .then((res) => {
        expect(res.status).to.eq(200);
        expect(res.body.lat).to.eq(0);
        expect(res.body.lng).to.eq(0);
        cy.request('DELETE', `/api/pois/${res.body.id}`); // clean up
      });
  });
});
