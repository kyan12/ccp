import path = require('path');

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(process.env.HOME || '/Users/crab', 'coding-control-plane'));
const JOBS_DIR: string = path.join(ROOT, 'jobs');

module.exports = {
  ROOT,
  JOBS_DIR,
};

export { ROOT, JOBS_DIR };
