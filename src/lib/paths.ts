import path = require('path');

// When compiled, __dirname is dist/lib/ — resolve up two levels to repo root
const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const JOBS_DIR: string = path.join(ROOT, 'jobs');

module.exports = {
  ROOT,
  JOBS_DIR,
};

export { ROOT, JOBS_DIR };
