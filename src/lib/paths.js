const path = require('path');

const ROOT = path.resolve(process.env.CCP_ROOT || path.join(process.env.HOME || '/Users/crab', 'coding-control-plane'));
const JOBS_DIR = path.join(ROOT, 'jobs');

module.exports = {
  ROOT,
  JOBS_DIR,
};
