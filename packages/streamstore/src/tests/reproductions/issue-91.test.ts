import { describe, expect, it } from "vitest";
import * as Redacted from "../../lib/redacted.js";

describe("Issue #91 reproduction", () => {
	it("should not export proto as a named export", () => {
		// proto should not be accessible — it is an internal implementation detail
		expect("proto" in Redacted).toBe(false);
	});

	it("should not export redactedRegistry as a named export", () => {
		// redactedRegistry should not be accessible — it holds secret values
		expect("redactedRegistry" in Redacted).toBe(false);
	});

	it("should always return '<redacted>' from JSON.stringify", () => {
		const secret = Redacted.make("my-super-secret-token");
		expect(JSON.stringify(secret)).toBe('"<redacted>"');
	});

	it("should always return '<redacted>' from toString", () => {
		const secret = Redacted.make("my-super-secret-token");
		expect(String(secret)).toBe("<redacted>");
	});

	it("should not allow the prototype toJSON to be overridden externally", () => {
		const secret = Redacted.make("hunter2");

		// Even if someone gets a reference to the prototype via the instance,
		// the frozen prototype should prevent mutation.
		const prototype = Object.getPrototypeOf(secret);
		expect(() => {
			prototype.toJSON = function () {
				return Redacted.value(this);
			};
		}).toThrow();

		// The secret should still be redacted
		expect(JSON.stringify(secret)).toBe('"<redacted>"');
	});

	it("should still allow value() to retrieve the secret", () => {
		const secret = Redacted.make("correct-horse-battery-staple");
		expect(Redacted.value(secret)).toBe("correct-horse-battery-staple");
	});

	it("should still allow unsafeWipe() to delete the secret", () => {
		const secret = Redacted.make("ephemeral-secret");
		expect(Redacted.value(secret)).toBe("ephemeral-secret");
		expect(Redacted.unsafeWipe(secret)).toBe(true);
		expect(() => Redacted.value(secret)).toThrow("Unable to get redacted value");
	});
});
