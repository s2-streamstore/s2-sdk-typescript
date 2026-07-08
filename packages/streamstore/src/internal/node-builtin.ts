/**
 * Load a Node builtin module without `import()` syntax, which bundlers try to
 * resolve and Hermes bytecode compilation rejects even in never-executed code
 * paths. Only call this in Node-only code.
 */
export const loadNodeBuiltin = (specifier: string): Promise<unknown> => {
	const getBuiltin = (
		globalThis as {
			process?: { getBuiltinModule?: (id: string) => unknown };
		}
	).process?.getBuiltinModule;
	if (getBuiltin) {
		const mod = getBuiltin(specifier);
		if (mod) {
			return Promise.resolve(mod);
		}
	}
	// Runtimes without process.getBuiltinModule: indirect import keeps the
	// syntax out of the compiled output.
	return new Function("s", "return import(s)")(specifier);
};
