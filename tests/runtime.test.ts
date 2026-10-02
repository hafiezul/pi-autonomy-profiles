import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoMode from "../index.ts";
import type { Decision, PermissionMode } from "../src/types.ts";
import {
	clearSessionApprovals,
	effectiveRuntimeMode,
	isAutoPaused,
	promptForDecision,
	recordDecision,
	resetAutoModeState,
} from "../src/runtime.ts";

function askDecision(sessionKey: string): Decision {
	return { action: "ask", reason: "needs approval", sessionKey };
}

function guardrailDenial(): Decision {
	return { action: "deny", reason: "guardrail hit", guardrail: true };
}

function plainDenial(): Decision {
	return { action: "deny", reason: "denied by rule" };
}

function allowDecision(): Decision {
	return { action: "allow" };
}

function rk(
	decision: Decision,
	mode: PermissionMode = "auto",
	ctx: ExtensionContext = { hasUI: false } as ExtensionContext,
): void {
	recordDecision(decision, mode, ctx);
}

function promptContext(): {
	ctx: ExtensionContext;
	prompts: () => number;
} {
	let count = 0;
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		ui: {
			select: async () => {
				count++;
				return "Allow for session";
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, prompts: () => count };
}

test("session approvals are FIFO bounded", async () => {
	resetAutoModeState();
	clearSessionApprovals();
	const { ctx, prompts } = promptContext();

	for (let i = 0; i < 256; i++) {
		assert.equal(await promptForDecision(askDecision(`k${i}`), ctx), true);
	}
	assert.equal(prompts(), 256);

	assert.equal(await promptForDecision(askDecision("k256"), ctx), true);
	assert.equal(prompts(), 257);

	await promptForDecision(askDecision("k0"), ctx);
	assert.equal(prompts(), 258, "oldest approval was evicted and re-prompted");

	await promptForDecision(askDecision("k1"), ctx);
	assert.equal(prompts(), 259, "next-oldest approval was evicted too");

	await promptForDecision(askDecision("k256"), ctx);
	assert.equal(prompts(), 259, "retained keys do not prompt again");
});

test("clearSessionApprovals drops remembered approvals", async () => {
	resetAutoModeState();
	clearSessionApprovals();
	const { ctx, prompts } = promptContext();

	await promptForDecision(askDecision("approved"), ctx);
	assert.equal(prompts(), 1);
	await promptForDecision(askDecision("approved"), ctx);
	assert.equal(prompts(), 1, "remembered approval suppresses the prompt");

	clearSessionApprovals();
	await promptForDecision(askDecision("approved"), ctx);
	assert.equal(prompts(), 2, "cleared approvals prompt again");
});

test("auto mode pauses after three consecutive guardrail denials", () => {
	resetAutoModeState();
	clearSessionApprovals();
	rk(guardrailDenial());
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), false);
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), true);
	assert.equal(effectiveRuntimeMode("auto"), "default");
	assert.equal(effectiveRuntimeMode("dontAsk"), "dontAsk");
});

test("an allow resets the consecutive guardrail count", () => {
	resetAutoModeState();
	clearSessionApprovals();
	rk(guardrailDenial());
	rk(allowDecision());
	rk(guardrailDenial());
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), false, "consecutive count restarted after allow");
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), true);
});

test("non-guardrail denials and other modes do not pause auto mode", () => {
	resetAutoModeState();
	clearSessionApprovals();
	for (let i = 0; i < 25; i++) rk(plainDenial());
	assert.equal(isAutoPaused(), false);

	resetAutoModeState();
	rk(guardrailDenial(), "default");
	assert.equal(isAutoPaused(), false);
});

test("twenty accumulated guardrail denials pause auto mode", () => {
	resetAutoModeState();
	clearSessionApprovals();
	for (let i = 0; i < 19; i++) {
		rk(guardrailDenial());
		rk(allowDecision());
	}
	assert.equal(isAutoPaused(), false);
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), true);
});

test("resetAutoModeState clears pause and counters", () => {
	resetAutoModeState();
	rk(guardrailDenial());
	rk(guardrailDenial());
	rk(guardrailDenial());
	assert.equal(isAutoPaused(), true);
	resetAutoModeState();
	assert.equal(isAutoPaused(), false);
	assert.equal(effectiveRuntimeMode("auto"), "auto");
});

test("autoMode registration clears session approvals on session_start", async () => {
	resetAutoModeState();
	clearSessionApprovals();
	const { ctx, prompts } = promptContext();
	await promptForDecision(askDecision("pre-dispose"), ctx);
	assert.equal(prompts(), 1);

	const handlers = new Map<
		string,
		(event: unknown, ctx: unknown) => unknown
	>();
	const pi = {
		registerCommand: () => {},
		on: (
			name: string,
			handler: (event: unknown, ctx: unknown) => unknown,
		) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	autoMode(pi);
	const handler = handlers.get("session_start");
	assert.ok(handler, "autoMode must register the session_start handler");

	await handler({ type: "session_start", reason: "new" }, ctx);
	await promptForDecision(askDecision("pre-dispose"), ctx);
	assert.equal(prompts(), 2, "approval from the previous session is gone");
});

type ToolCallHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => Promise<unknown>;

async function toolCallHandler(
	fixture: { cwd: string; mode: string },
): Promise<ToolCallHandler> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerCommand: () => {},
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	previousGlobalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fixture.cwd;
	await mkdir(join(fixture.cwd, "extensions", EXTENSION_ID), {
		recursive: true,
	});
	await writeFile(
		join(fixture.cwd, "extensions", EXTENSION_ID, "config.json"),
		`${JSON.stringify({ mode: fixture.mode })}\n`,
		"utf8",
	);

	autoMode(pi as ExtensionAPI);
	return handlers.get("tool_call") as ToolCallHandler;
}

let previousGlobalAgentDir: string | undefined;
const EXTENSION_ID = "pi-autonomy-profiles";

test("autoMode tool_call wiring allows read-only, blocks guardrails, and pauses after three denials", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "pi-autonomy-wiring-"));
	await mkdir(join(tmp, "repo"), { recursive: true });
	try {
		const handler = await toolCallHandler({ cwd: tmp, mode: "auto" });
		const ctx = { cwd: join(tmp, "repo"), hasUI: false } as ExtensionContext;

		assert.deepEqual(await handler({ toolName: "bash", input: { command: "ls" } }, ctx), undefined);
		const guardrail = { toolName: "bash", input: { command: "rm -rf build" } };
		const blocked = (await handler(guardrail, ctx)) as {
			block: boolean;
			reason: string;
		};
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /recursive-force-delete/);

		await handler(guardrail, ctx);
		await handler(guardrail, ctx);
		assert.equal(
			isAutoPaused(),
			true,
			"three wired guardrail denials pause auto mode",
		);
	} finally {
		if (previousGlobalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousGlobalAgentDir;
		}
		await rm(tmp, { recursive: true, force: true });
	}
});
