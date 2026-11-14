// Default Jest projects (`npx jest`, `npm test`). The e2e suite has its own config (jest.e2e.config.js)
// and is never part of the default run.
const { coreProject, appProject } = require('./jest.projects');

module.exports = {
  projects: [coreProject, appProject],
};
