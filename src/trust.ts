import { statSync } from "node:fs";
import { join } from "node:path";
import {
	ProjectTrustStore,
	hasProjectTrustInputs,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "./config.ts";

type TrustStamp = { stamps: string; trusted: boolean };

interface TrustQueryable {
	cwd?: unknown;
	isProjectTrusted?: unknown;
}

const TRUST_CACHE_MAX_ENTRIES = 64;

const trustCache = new Map<string, TrustStamp>();

function trustStoreStamps(): string {
	try {
		const stats = statSync(join(agentDir(), "trust.json"), { bigint: true });
		return `${stats.size}:${stats.mtimeNs}`;
	} catch {
		return "absent";
	}
}

function computeProjectTrust(cwd: string): boolean {
	if (!hasProjectTrustInputs(cwd)) return true;
	try {
		return new ProjectTrustStore(agentDir()).get(cwd) === true;
	} catch {
		return false;
	}
}

export function isProjectTrustedContext(ctx: object): boolean {
	const queryable = ctx as TrustQueryable;
	if (typeof queryable.isProjectTrusted === "function") {
		return queryable.isProjectTrusted();
	}
	if (typeof queryable.cwd !== "string") return false;

	const stamps = trustStoreStamps();
	const hit = trustCache.get(queryable.cwd);
	if (hit && hit.stamps === stamps) return hit.trusted;

	const trusted = computeProjectTrust(queryable.cwd);
	if (trustCache.size >= TRUST_CACHE_MAX_ENTRIES) trustCache.clear();
	trustCache.set(queryable.cwd, { stamps, trusted });
	return trusted;
}
