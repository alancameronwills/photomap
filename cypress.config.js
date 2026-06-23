const { defineConfig } = require('cypress');

// PhotoMap e2e tests run against a live local server (npm start) on PORT 3000.
// Override with CYPRESS_BASE_URL / CYPRESS_ADMIN_PASSWORD if your setup differs.
module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:3000',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    // Desktop viewport: min(width,height) > 768 so tracking mode does NOT
    // auto-enable (see app.js setTrackingMode auto-enable rule).
    viewportWidth: 1280,
    viewportHeight: 800,
    video: false,
    env: {
      // Default matches the commented-out ADMIN_PASSWORD in .env ("changeme").
      adminPassword: process.env.CYPRESS_ADMIN_PASSWORD || 'changeme',
    },
  },
});
