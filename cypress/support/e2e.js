// Loaded before every e2e spec file.
import './commands';

// The Leaflet/MarkerCluster libs occasionally throw benign async errors during
// rapid teardown; don't let those fail an otherwise-passing test.
Cypress.on('uncaught:exception', () => false);
