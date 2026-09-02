import { spawn } from 'node:child_process';
import fs from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
if (process.env.ECC_DESCENDANT_PID_FILE) fs.writeFileSync(process.env.ECC_DESCENDANT_PID_FILE, String(descendant.pid));
console.log(JSON.stringify({ tokens: 10, toolCalls: 3, wallSeconds: 0, processes: 2 }));
setTimeout(() => {}, 30000);
