import path = require('path');
const { ROOT } = require('./jobs');

interface LaunchdOptions {
  label?: string;
  intervalMs?: number | string;
  maxConcurrent?: number | string;
  nodePath?: string;
  pathEnv?: string;
  homeEnv?: string;
  shellEnv?: string;
  opServiceAccountToken?: string;
  extraEnv?: Record<string, string | undefined | null>;
  envFilePath?: string;
  port?: number | string;
}

function baseEnv(options: LaunchdOptions = {}): { pathEnv: string; homeEnv: string; shellEnv: string; opServiceAccountToken: string } {
  return {
    pathEnv: options.pathEnv || process.env.CCP_PATH_ENV || '/Users/kyan/.local/bin:/Users/kyan/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    homeEnv: options.homeEnv || process.env.CCP_HOST_HOME || '/Users/kyan',
    shellEnv: options.shellEnv || process.env.SHELL || '/bin/zsh',
    opServiceAccountToken: options.opServiceAccountToken || process.env.OP_SERVICE_ACCOUNT_TOKEN || '',
  };
}

function buildEnvBlock(options: LaunchdOptions = {}, publicEnv: Record<string, string> = {}): string {
  const { pathEnv, homeEnv, shellEnv } = baseEnv(options);
  const envFilePath = options.envFilePath || path.join(ROOT, 'supervisor', 'daemon', 'intake.env.local');
  const lines: string[] = [
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>PATH</key>',
    `      <string>${pathEnv}</string>`,
    '      <key>HOME</key>',
    `      <string>${homeEnv}</string>`,
    '      <key>SHELL</key>',
    `      <string>${shellEnv}</string>`,
    '      <key>CCP_ENV_FILE</key>',
    `      <string>${envFilePath}</string>`,
  ];
  for (const [key, value] of Object.entries(publicEnv)) {
    lines.push(`      <key>${key}</key>`);
    lines.push(`      <string>${value}</string>`);
  }
  lines.push('    </dict>');
  return lines.join('\n');
}

function buildSupervisorPlist(options: LaunchdOptions = {}): string {
  const label = options.label || 'ai.ccp.supervisor';
  const intervalMs = Number(options.intervalMs || process.env.CCP_SUPERVISOR_INTERVAL_MS || 15000);
  const maxConcurrent = Number(options.maxConcurrent || process.env.CCP_MAX_CONCURRENT || 1);
  const nodePath = options.nodePath || process.execPath;
  const program = path.join(ROOT, 'dist', 'bin', 'launchd-runner.js');
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
      <string>supervisor</string>
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

function buildIntakePlist(options: LaunchdOptions = {}): string {
  const label = options.label || 'ai.ccp.intake';
  const port = Number(options.port || process.env.CCP_INTAKE_PORT || 4318);
  const nodePath = options.nodePath || process.execPath;
  const program = path.join(ROOT, 'dist', 'bin', 'launchd-runner.js');
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
      <string>intake</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
${buildEnvBlock(options, { CCP_INTAKE_PORT: String(port) })}
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

export { buildSupervisorPlist, buildIntakePlist };
