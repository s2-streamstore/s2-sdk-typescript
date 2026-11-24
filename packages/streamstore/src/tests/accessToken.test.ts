import { expect, it } from "vitest";
import { S2Error } from "../error.js";
import { S2 } from "../index.js";

it("rejects empty, non-string, and header-invalid access tokens without echoing them", () => {
	const secret = "SECRET-TOKEN";
	const invalid: unknown[] = [
		"",
		" ",
		"\t",
		`${secret} `,
		`${secret}\t`,
		`${secret}\n`,
		`${secret}\r`,
		`${secret}\0`,
		`${secret}\x7f`,
		false,
		0,
		undefined,
		null,
	];

	for (const accessToken of invalid) {
		let error: unknown;
		try {
			new S2({ accessToken: accessToken as string });
		} catch (e) {
			error = e;
		}
		expect(error, `token=${JSON.stringify(accessToken)}`).toBeInstanceOf(
			S2Error,
		);
		expect((error as S2Error).origin).toBe("sdk");
		expect((error as S2Error).message).not.toContain(secret);
	}

	expect(() => new S2({ accessToken: "t" })).not.toThrow();
	expect(() => new S2({ accessToken: secret })).not.toThrow();
});
