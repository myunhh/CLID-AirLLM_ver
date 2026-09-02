import assert from "node:assert/strict";
import test from "node:test";

import { addMember, archive, buildTeam, setMemberStatus, setTeamStatus } from "../scripts/team-state.mjs";

const STATUSES = ["pending", "active", "reported", "blocked", "archived"];
const ALLOWED = new Set([
	"pending->active",
	"pending->blocked",
	"pending->archived",
	"active->reported",
	"active->blocked",
	"active->archived",
	"reported->active",
	"reported->archived",
	"blocked->active",
	"blocked->archived",
]);

function memberTeam(status) {
	const team = buildTeam({ teamName: "lifecycle", sessionName: "test", transport: "codex_app", now: "2026-09-02T00:00:00.000Z" });
	addMember(team, { id: "A", name: "member-a", focus: "owned lifecycle state", lens: "area" });
	team.members[0].status = status;
	return team;
}

test("all 25 member status pairs enforce the binding transition matrix without rejected mutations", () => {
	let allowedCount = 0;
	let rejectedCount = 0;
	for (const from of STATUSES) {
		for (const to of STATUSES) {
			const team = memberTeam(from);
			const before = JSON.stringify(team);
			const eventsBefore = team.log.length;
			const key = `${from}->${to}`;
			if (ALLOWED.has(key)) {
				setMemberStatus(team, { id: "A", status: to });
				assert.equal(team.members[0].status, to, key);
				assert.equal(team.log.length, eventsBefore + 1, key);
				assert.equal(team.log.at(-1).event, "set-status", key);
				allowedCount++;
			} else {
				assert.throws(() => setMemberStatus(team, { id: "A", status: to }), /ILLEGAL_MEMBER_TRANSITION/, key);
				assert.equal(JSON.stringify(team), before, key);
				rejectedCount++;
			}
		}
	}
	assert.equal(allowedCount, 10);
	assert.equal(rejectedCount, 15);
});

test("member archive obeys the same terminal-state rule", () => {
	const team = memberTeam("active");
	archive(team, { id: "A" });
	assert.equal(team.members[0].status, "archived");
	const before = JSON.stringify(team);
	assert.throws(() => archive(team, { id: "A" }), /ILLEGAL_MEMBER_TRANSITION/);
	assert.equal(JSON.stringify(team), before);
});

test("team lifecycle permits only active to archived and rejects without mutation", () => {
	const active = memberTeam("pending");
	const activeBefore = JSON.stringify(active);
	assert.throws(() => setTeamStatus(active, { status: "active" }), /ILLEGAL_TEAM_TRANSITION/);
	assert.equal(JSON.stringify(active), activeBefore);

	setTeamStatus(active, { status: "archived" });
	assert.equal(active.status, "archived");
	assert.ok(active.archivedAt);
	assert.equal(active.log.at(-1).event, "set-team-status");

	for (const to of ["active", "archived"]) {
		const before = JSON.stringify(active);
		assert.throws(() => setTeamStatus(active, { status: to }), /ILLEGAL_TEAM_TRANSITION/);
		assert.equal(JSON.stringify(active), before);
	}
});

test("team archive records exactly one team-level event and cannot replay", () => {
	const team = memberTeam("active");
	const eventsBefore = team.log.length;
	archive(team);
	assert.equal(team.status, "archived");
	assert.equal(team.members[0].status, "archived");
	assert.equal(team.log.length, eventsBefore + 1);
	assert.equal(team.log.at(-1).event, "archive");
	const before = JSON.stringify(team);
	assert.throws(() => archive(team), /ILLEGAL_TEAM_TRANSITION/);
	assert.equal(JSON.stringify(team), before);
});
