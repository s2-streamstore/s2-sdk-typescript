export interface Redacted<out A = string> {}

export declare namespace Redacted {
	export type Value<T extends Redacted<any>> = [T] extends [Redacted<infer _A>]
		? _A
		: never;
}

export const redactedRegistry = new WeakMap<Redacted<any>, any>();

const NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

export const proto = {
	toString() {
		return "<redacted>";
	},
	toJSON() {
		return "<redacted>";
	},
	[NodeInspectSymbol]() {
		return "<redacted>";
	},
};

export const make = <T>(value: T): Redacted<T> => {
	const redacted = Object.create(proto);
	redactedRegistry.set(redacted, value);
	return redacted;
};

export const value = <T>(self: Redacted<T>): T => {
	if (redactedRegistry.has(self)) {
		return redactedRegistry.get(self);
	} else {
		throw new Error("Unable to get redacted value");
	}
};

export const unsafeWipe = <T>(self: Redacted<T>): boolean =>
	redactedRegistry.delete(self);
