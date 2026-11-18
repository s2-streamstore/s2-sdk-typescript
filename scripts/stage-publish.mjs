// Stages each unreleased package with `npm stage publish`; a maintainer then
// approves it on npmjs.com. The `New tag:` lines make changesets/action create
// the GitHub release, as `changeset publish` did.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { encoding: "utf8", ...opts })?.trim();

const succeeds = (cmd, args) => {
	try {
		run(cmd, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const isPublished = (spec) => {
	try {
		return run("npm", ["view", spec, "version"]) !== "";
	} catch (err) {
		if (String(err.stderr).includes("E404")) return false;
		throw err;
	}
};

const failed = [];
for (const dir of readdirSync("packages").sort()) {
	const cwd = join("packages", dir);
	const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	if (pkg.private) continue;
	const spec = `${pkg.name}@${pkg.version}`;
	const ref = `refs/tags/${spec}`;

	// A staged version is not visible on the registry, so the tag is what stops a
	// later run from staging it again. It is pushed here, not left to
	// changesets/action, which does nothing if any package fails to stage.
	if (run("git", ["ls-remote", "--tags", "origin", ref])) {
		console.log(`${spec} is already staged or published`);
	} else if (isPublished(spec)) {
		console.log(`${spec} is already published`);
		continue;
	} else {
		try {
			run("npm", ["stage", "publish"], { cwd, stdio: "inherit" });
		} catch {
			failed.push(spec);
			continue;
		}
		run("git", ["push", "origin", `HEAD:${ref}`], { stdio: "inherit" });
	}

	// Also covers a tag whose release was skipped because an earlier run failed.
	if (!succeeds("gh", ["release", "view", spec])) {
		console.log(`New tag: ${spec}`);
	}
}

if (failed.length > 0) {
	console.error(`Failed to stage: ${failed.join(", ")}`);
	process.exit(1);
}
