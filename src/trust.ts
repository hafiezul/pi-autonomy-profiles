import {
	ProjectTrustStore,
	hasProjectTrustInputs,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "./config.ts";

export function isProjectTrustedContext(ctx: object): boolean {
	if ("isProjectTrusted" in ctx && typeof ctx.isProjectTrusted === "function") {
		return ctx.isProjectTrusted();
	}

	if ("cwd" in ctx && typeof ctx.cwd === "string") {
		if (!hasProjectTrustInputs(ctx.cwd)) return true;
		try {
			return new ProjectTrustStore(agentDir()).get(ctx.cwd) === true;
		} catch {
			return false;
		}
	}

	return false;
}
