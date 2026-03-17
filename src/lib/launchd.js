const path = require('path');
const { ROOT } = require('./jobs');

function baseEnv(options = {}) {
  return {
    pathEnv: options.pathEnv || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    homeEnv: options.homeEnv || process.env.HOME || '/Users/crab',
    shellEnv: options.shellEnv || process.env.SHELL || '/bin/zsh',
    opServiceAccountToken: options.opServiceAccountToken || process.env.OP_SERVICE_ACCOUNT_TOKEN || '',
  };
}

function buildEnvBlock(options = {}) {
  const { pathEnv, homeEnv, shellEnv, opServiceAccountToken } = baseEnv(options);
  const extra = options.extraEnv || {};
  const lines = [
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>PATH</key>',
    `      <string>${pathEnv}</string>`,
    '      <key>HOME</key>',
    `      <string>${homeEnv}</string>`,
    '      <key>SHELL</key>',
    `      <string>${shellEnv}</string>`,
  ];
  if (opServiceAccountToken) {
    lines.push('      <key>OP_SERVICE_ACCOUNT_TOKEN</key>');
    lines.push(`      <string>${opServiceAccountToken}</string>`);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`      <key>${key}</key>`);
    lines.push(`      <string>${String(value)}</string>`);
  }
  lines.push('    </dict>');
  return lines.join('\n');
}

function buildSupervisorPlist(options = {}) {
  const label = options.label || 'ai.openclaw.coding-control-plane';
  const intervalMs = Number(options.intervalMs || process.env.CCP_SUPERVISOR_INTERVAL_MS || 15000);
  const maxConcurrent = Number(options.maxConcurrent || process.env.CCP_MAX_CONCURRENT || 1);
  const nodePath = options.nodePath || process.execPath;
  const program = path.join(ROOT, 'src', 'bin', 'supervisor.js');
  const stdoutPath = path.join(ROOT, 'supervisor', 'daemon', 'launchd.stdout.log');
  const stderrPath = path.join(ROOT, 'supervisor', 'daemon', 'launchd.stderr.log');
  const workingDirectory = ROOT;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${program}</string>
      <string>--interval=${intervalMs}</string>
      <string>--max-concurrent=${maxConcurrent}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
${buildEnvBlock(options)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>
`;
}

function buildIntakePlist(options = {}) {
  const label = options.label || 'ai.openclaw.coding-control-plane.intake';
  const port = Number(options.port || process.env.CCP_INTAKE_PORT || 4318);
  const nodePath = options.nodePath || process.execPath;
  const program = path.join(ROOT, 'src', 'bin', 'intake-server.js');
  const stdoutPath = path.join(ROOT, 'supervisor', 'daemon', 'intake.stdout.log');
  const stderrPath = path.join(ROOT, 'supervisor', 'daemon', 'intake.stderr.log');
  const workingDirectory = ROOT;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${program}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
${buildEnvBlock({ ...options, extraEnv: { ...(options.extraEnv || {}), CCP_INTAKE_PORT: port } })}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>
`;
}

module.exports = {
  buildSupervisorPlist,
  buildIntakePlist,
};
