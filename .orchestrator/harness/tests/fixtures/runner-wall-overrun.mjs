import { spawn } from 'node:child_process';
import fs from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
if (process.env.ECC_DESCENDANT_PID_FILE) fs.writeFileSync(process.env.ECC_DESCENDANT_PID_FILE, String(descendant.pid));
setTimeout(() => console.log(JSON.stringify({ tokens: 1, toolCalls: 0, wallSeconds: 2, processes: 2 })), 2000);
