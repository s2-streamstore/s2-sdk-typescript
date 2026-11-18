// Stages each unreleased package with `npm stage publish`; a maintainer then
// approves it on npmjs.com. The `New tag:` lines make changesets/action push
// the tag and create the GitHub release, as `changeset publish` did.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

const isPublished = (spec) => {
	try {
		return run("npm", ["view", spec, "version"]) !== "";
	} catch (err) {
		if (String(err.stderr).includes("E404")) return false;
		throw err;
	}
};

for (const dir of readdirSync("packages").sort()) {
	const cwd = join("packages", dir);
	const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	if (pkg.private) continue;
	const spec = `${pkg.name}@${pkg.version}`;

	// A staged version is not visible on the registry, so the tag pushed when it
	// was staged is what stops a later run from staging it again.
	const tagged = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${spec}`]);
	if (tagged || isPublished(spec)) {
		console.log(`${spec} is already staged or published, skipping`);
		continue;
	}

	run("npm", ["stage", "publish"], { cwd, stdio: "inherit" });
	console.log(`New tag: ${spec}`);
}
