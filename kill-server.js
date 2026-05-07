// Kills any process currently listening on the server port before startup.
const { execSync } = require('child_process');
const port = 3000;
try {
  const pid = execSync(
    `powershell -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
    { encoding: 'utf8' }
  ).trim();
  if (pid) {
    execSync(`taskkill /F /PID ${pid}`);
    console.log(`Killed existing server (PID ${pid}) on port ${port}`);
  }
} catch {}
