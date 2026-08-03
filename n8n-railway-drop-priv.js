process.setgid('node');
process.setuid('node');

const { spawn } = require('child_process');
const child = spawn('n8n', process.argv.slice(2), { stdio: 'inherit' });

child.on('exit', (code, signal) => process.exit(code === null ? 1 : code));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
