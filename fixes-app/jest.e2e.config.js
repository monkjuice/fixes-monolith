// `npm run test:e2e`: runs e2e/ against a live fixes-server. Not part of `npx jest`.
const { e2eProject } = require('./jest.projects');

module.exports = {
  ...e2eProject,
  // Real network round trips (argon2 on login, WebSocket waits) are slower than unit tests.
  testTimeout: 60_000,
  // One shared server: run test files one after another to keep rate limits and ordering predictable.
  maxWorkers: 1,
};
