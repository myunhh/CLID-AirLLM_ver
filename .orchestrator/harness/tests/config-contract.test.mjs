import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");
const configPath = resolve(root, ".codex", "config.toml");
const expectedRoles = {
	explorer: { file: "agents/explorer.toml", model: "gpt-5.6-luna", readOnly: true },
	docs_researcher: { file: "agents/docs-researcher.toml", model: "gpt-5.6-luna", readOnly: true },
	reviewer: { file: "agents/reviewer.toml", model: "gpt-5.6-sol", readOnly: true },
	worker: { file: "agents/worker.toml", model: "gpt-5.6-terra", readOnly: false },
	judge: { file: "agents/judge.toml", model: "gpt-5.6-sol", readOnly: true },
};

function section(source, name) {
	const header = `[${name}]`;
	const part = source.split(/\r?\n(?=\[)/).find((candidate) => candidate.startsWith(header));
	return part?.slice(header.length).trimStart() ?? "";
}

function value(source, key) {
	return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"))?.[1] ?? null;
}

test("project role routing uses the 5.6 policy with existing registered configs", async () => {
	const config = await readFile(configPath, "utf8");
	assert.equal(value(config, "model"), "gpt-5.6-sol", "main/default model");
	assert.match(section(config, "agents"), /^enabled\s*=\s*true\s*$/m);

	for (const [role, expected] of Object.entries(expectedRoles)) {
		const registration = section(config, `agents.${role}`);
		assert.equal(value(registration, "config_file"), expected.file, `${role} registration`);
		const rolePath = resolve(root, ".codex", expected.file);
		await access(rolePath);
		const roleConfig = await readFile(rolePath, "utf8");
		assert.equal(value(roleConfig, "model"), expected.model, `${role} model`);
		assert.ok(!roleConfig.includes("gpt-5.5"), `${role} must not retain gpt-5.5`);
		assert.equal(value(roleConfig, "sandbox_mode") === "read-only", expected.readOnly, `${role} read-only policy`);
	}

	assert.ok(!config.includes("gpt-5.5"), "main config must not retain gpt-5.5");
	assert.ok(!config.includes("allow_user_model_override = false"), "explicit user model overrides remain permitted");
});
