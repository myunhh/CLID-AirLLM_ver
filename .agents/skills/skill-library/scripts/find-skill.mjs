import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node find-skill.mjs --query <text> [--scope all|project|plugin] [--limit 1..5] [--root <repo>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: "C:/vsc", scope: "all", limit: 5, query: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--root", "--scope", "--limit", "--query"].includes(key)) {
      usage(`Invalid argument: ${key}`);
    }
    const values = [];
    while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      values.push(argv[index + 1]);
      index += 1;
    }
    if (values.length === 0) usage(`Missing value for ${key}`);
    const value = values.join(" ");
    options[key.slice(2)] = key === "--limit" ? Number(value) : value;
  }
  if (!options.query.trim()) usage("--query is required");
  if (!new Set(["all", "project", "plugin"]).has(options.scope)) usage("Invalid --scope");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 5) {
    usage("--limit must be an integer from 1 to 5");
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function tokens(query) {
  const ignored = new Set(["and", "for", "from", "the", "this", "with", "use", "task"]);
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.:+-]+/u))]
    .filter((token) => token.length > 1 && !ignored.has(token));
}

function score(entry, query, queryTokens) {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const normalized = query.toLowerCase().trim();
  let value = name === normalized ? 1000 : 0;
  if (name.includes(normalized)) value += 250;
  if (description.includes(normalized)) value += 100;
  for (const token of queryTokens) {
    if (name.includes(token)) value += 50;
    if (description.includes(token)) value += 10;
  }
  return value;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(options.root);
const entries = [];

if (options.scope !== "plugin") {
  const catalog = readJson(path.join(repoRoot, ".skills", "catalog.json"));
  for (const skill of catalog.library) {
    entries.push({
      source: "project",
      name: skill.name,
      description: skill.description,
      skill_md: path.join(repoRoot, skill.path, "SKILL.md").replaceAll("\\", "/"),
      sha256: skill.skill_sha256,
    });
  }
}

if (options.scope !== "project") {
  const catalog = readJson(path.join(repoRoot, ".skills", "plugin-catalog.json"));
  for (const skill of catalog.skills) {
    entries.push({
      source: "plugin",
      name: skill.visible_name,
      description: skill.frontmatter_description,
      skill_md: skill.resolved_skill_md,
      resolver_glob: skill.resolver_glob,
      sha256: skill.sha256,
    });
  }
}

const queryTokens = tokens(options.query);
const matches = entries
  .map((entry) => ({ ...entry, score: score(entry, options.query, queryTokens) }))
  .filter((entry) => entry.score > 0)
  .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
  .slice(0, options.limit)
  .map((entry) => ({
    ...entry,
    description:
      entry.description.length > 600 ? `${entry.description.slice(0, 599)}…` : entry.description,
    description_truncated: entry.description.length > 600,
  }));

process.stdout.write(`${JSON.stringify({ query: options.query, scope: options.scope, matches }, null, 2)}\n`);
