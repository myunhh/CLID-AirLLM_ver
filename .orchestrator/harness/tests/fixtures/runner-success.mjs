import fs from 'node:fs';
if (process.env.ECC_RUNNER_MARKER) fs.writeFileSync(process.env.ECC_RUNNER_MARKER, 'executed');
console.log(JSON.stringify({ tokens: 10, toolCalls: 2, wallSeconds: 0, processes: 1 }));
