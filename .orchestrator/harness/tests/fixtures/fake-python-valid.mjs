import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-c') console.log(JSON.stringify({ version: [3, 12, 1], missingDependencies: [] }));
else {
  if (process.env.ECC_FAKE_PYTHON_MARKER) fs.writeFileSync(process.env.ECC_FAKE_PYTHON_MARKER, JSON.stringify(args));
  process.exitCode = 0;
}
