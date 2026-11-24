import { S2Error } from "./error.js";

type Scheme = "http" | "https";

const DEFAULT_SCHEME: Scheme = "https";
const DEFAULT_API_PATH = "/v1";
const BASIN_PLACEHOLDER_PREFIX = "{basin}.";

const IPV4_OCTET_REGEX = /^(?:0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP_REGEX = /^[0-9a-fA-F]{1,4}$/;
const DNS_LABEL_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const ALL_DIGITS_REGEX = /^[0-9]+$/;
const HEX_LITERAL_REGEX = /^0[xX][0-9a-fA-F]*$/;
const PORT_REGEX = /^[1-9][0-9]{0,4}$/;
const WHITESPACE_OR_CONTROL_REGEX = /[\s\x00-\x1f\x7f]/;

function validationError(message: string): S2Error {
	return new S2Error({ message, origin: "sdk" });
}

function formatEndpointForError(endpoint: string): string {
	// Never echo URLs containing `@` (may contain credentials) or query strings.
	return endpoint.includes("@") || endpoint.includes("?")
		? ""
		: `: "${endpoint}"`;
}

function isValidIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	for (const part of parts) {
		if (!IPV4_OCTET_REGEX.test(part) || Number(part) > 255) {
			return false;
		}
	}
	return true;
}

function isValidIpv6(address: string): boolean {
	if (!address || address.includes("%")) return false;
	const parts = address.split("::");
	if (parts.length > 2) return false;

	const parseGroups = (
		segment: string,
		allowIpv4Tail: boolean,
	): number | null => {
		if (segment === "") return 0;
		const groups = segment.split(":");
		let count = 0;
		for (let i = 0; i < groups.length; i++) {
			const group = groups[i]!;
			if (allowIpv4Tail && i === groups.length - 1 && group.includes(".")) {
				if (!isValidIpv4(group)) return null;
				count += 2;
			} else if (IPV6_GROUP_REGEX.test(group)) {
				count += 1;
			} else {
				return null;
			}
		}
		return count;
	};

	if (parts.length === 1) {
		return parseGroups(parts[0]!, true) === 8;
	}
	const left = parseGroups(parts[0]!, false);
	const right = parseGroups(parts[1]!, true);
	if (left === null || right === null) return false;
	return left + right < 8;
}

function isValidDnsName(host: string): boolean {
	const normalized = host.endsWith(".") ? host.slice(0, -1) : host;
	if (!normalized || normalized.length > 253) return false;
	const labels = normalized.split(".");
	for (const label of labels) {
		if (!DNS_LABEL_REGEX.test(label)) return false;
	}
	const tld = labels[labels.length - 1]!;
	// Reject all-numeric or hex-literal final labels (e.g. 127.0.0.999 or 127.0.0.1.)
	if (ALL_DIGITS_REGEX.test(tld) || HEX_LITERAL_REGEX.test(tld)) {
		return false;
	}
	return true;
}

export type EndpointTemplateInit = {
	/**
	 * Endpoint string in `[http(s)://][{basin}.]host[:port][/]` form.
	 *
	 * Without a scheme, defaults to `https`. An optional trailing `/` is accepted;
	 * paths, query strings, hash fragments, and user info are rejected.
	 * For basin endpoints, the host may begin with `{basin}.` when the remaining
	 * host is a DNS name.
	 */
	endpoint: string;
	/**
	 * Whether a leading `{basin}.` placeholder is permitted in the host.
	 * @default true
	 */
	allowBasinPlaceholder?: boolean;
};

export class EndpointTemplate {
	public readonly raw: string;
	public readonly scheme: Scheme;
	public readonly hostTemplate: string;
	public readonly port: string;
	public readonly pathTemplate: string;
	public readonly hasBasinPlaceholder: boolean;
	public readonly explicitPathProvided: boolean;

	constructor({
		endpoint,
		allowBasinPlaceholder = true,
	}: EndpointTemplateInit) {
		if (typeof endpoint !== "string" || !endpoint.trim()) {
			throw validationError("Endpoint cannot be empty");
		}
		if (WHITESPACE_OR_CONTROL_REGEX.test(endpoint)) {
			throw validationError(
				"Endpoint cannot contain whitespace or control characters",
			);
		}

		this.raw = endpoint;

		// 1. Parse optional scheme (defaults to https).
		let scheme: Scheme = DEFAULT_SCHEME;
		let rest = endpoint;
		const schemeSep = endpoint.indexOf("://");
		if (schemeSep !== -1) {
			const schemePart = endpoint.slice(0, schemeSep).toLowerCase();
			if (schemePart !== "http" && schemePart !== "https") {
				throw validationError(
					`Unsupported scheme "${endpoint.slice(0, schemeSep)}": expected http or https`,
				);
			}
			scheme = schemePart;
			rest = endpoint.slice(schemeSep + 3);
		}

		// 2. Reject query string, hash fragment, non-trailing path, and user info.
		if (rest.includes("?") || rest.includes("#")) {
			throw validationError(
				"Endpoint cannot include query string or hash fragment",
			);
		}

		let authority = rest;
		const slashIdx = rest.indexOf("/");
		if (slashIdx !== -1) {
			if (slashIdx !== rest.length - 1) {
				throw validationError(
					`Endpoint cannot include a path${formatEndpointForError(endpoint)}`,
				);
			}
			authority = rest.slice(0, slashIdx);
		}

		if (authority.includes("@")) {
			throw validationError("Endpoint cannot include user info");
		}
		if (!authority) {
			throw validationError(
				`Endpoint host cannot be empty${formatEndpointForError(endpoint)}`,
			);
		}

		// 3. Split authority into host and optional port.
		let hostPart: string;
		let portPart = "";
		if (authority.startsWith("[")) {
			const closeBracket = authority.indexOf("]");
			if (closeBracket === -1) {
				throw validationError(
					`Invalid IPv6 address in endpoint: "${endpoint}"`,
				);
			}
			hostPart = authority.slice(0, closeBracket + 1);
			const afterBracket = authority.slice(closeBracket + 1);
			if (afterBracket !== "") {
				if (!afterBracket.startsWith(":")) {
					throw validationError(`Invalid endpoint authority: "${endpoint}"`);
				}
				portPart = afterBracket.slice(1);
				if (!portPart) {
					throw validationError(`Endpoint port cannot be empty: "${endpoint}"`);
				}
			}
		} else {
			const firstColon = authority.indexOf(":");
			if (firstColon !== -1) {
				if (authority.indexOf(":", firstColon + 1) !== -1) {
					throw validationError(
						`Invalid endpoint host (IPv6 addresses must be enclosed in brackets): "${endpoint}"`,
					);
				}
				hostPart = authority.slice(0, firstColon);
				portPart = authority.slice(firstColon + 1);
				if (!portPart) {
					throw validationError(`Endpoint port cannot be empty: "${endpoint}"`);
				}
			} else {
				hostPart = authority;
			}
		}

		if (!hostPart) {
			throw validationError(`Endpoint host cannot be empty: "${endpoint}"`);
		}

		// 4. Validate port (1-65535) if provided.
		if (portPart !== "") {
			if (!PORT_REGEX.test(portPart) || Number(portPart) > 65535) {
				throw validationError(
					`Invalid endpoint port "${portPart}": must be an integer between 1 and 65535`,
				);
			}
		}

		// 5. Validate host and optional leading `{basin}.` placeholder.
		let hasBasinPlaceholder = false;
		let normalizedHost: string;
		if (hostPart.startsWith(BASIN_PLACEHOLDER_PREFIX)) {
			if (!allowBasinPlaceholder) {
				throw validationError(
					`Account endpoint cannot include {basin} placeholder: "${endpoint}"`,
				);
			}
			const dnsPart = hostPart.slice(BASIN_PLACEHOLDER_PREFIX.length);
			if (!isValidDnsName(dnsPart)) {
				throw validationError(
					`Basin endpoint with {basin}. placeholder must use a valid DNS name: "${endpoint}"`,
				);
			}
			hasBasinPlaceholder = true;
			normalizedHost = `${BASIN_PLACEHOLDER_PREFIX}${dnsPart.toLowerCase()}`;
		} else if (hostPart.startsWith("[") && hostPart.endsWith("]")) {
			const ipv6 = hostPart.slice(1, -1);
			if (!isValidIpv6(ipv6)) {
				throw validationError(
					`Invalid IPv6 address in endpoint: "${endpoint}"`,
				);
			}
			normalizedHost = new URL(`https://${hostPart}/`).hostname;
		} else if (isValidIpv4(hostPart)) {
			normalizedHost = hostPart;
		} else if (isValidDnsName(hostPart)) {
			normalizedHost = hostPart.toLowerCase();
		} else {
			throw validationError(`Invalid endpoint host: "${endpoint}"`);
		}

		this.scheme = scheme;
		this.hostTemplate = normalizedHost;
		this.port = portPart;
		this.pathTemplate = DEFAULT_API_PATH;
		this.explicitPathProvided = false;
		this.hasBasinPlaceholder = hasBasinPlaceholder;
	}

	/**
	 * Resolve the template into a base URL string.
	 *
	 * - If `{basin}.` prefixes the hostname, `{basin}` is substituted verbatim
	 *   (basin names are validated against `BasinNameStr`).
	 */
	public baseUrl(basin?: string): string {
		const host =
			basin && this.hasBasinPlaceholder
				? this.hostTemplate.replace(BASIN_PLACEHOLDER_PREFIX, `${basin}.`)
				: this.hostTemplate;

		const authority = this.port ? `${host}:${this.port}` : host;
		return `${this.scheme}://${authority}${this.pathTemplate}`;
	}
}

export type S2EndpointsInit = {
	/**
	 * Account endpoint (`[http(s)://]host[:port][/]`).
	 * Must be provided together with `basin` and use the same scheme.
	 */
	account: string;
	/**
	 * Basin endpoint (`[http(s)://][{basin}.]host[:port][/]`).
	 * Must be provided together with `account` and use the same scheme.
	 * May begin with `{basin}.` when the host is a DNS name.
	 */
	basin: string;
};

const DEFAULT_ACCOUNT_ENDPOINT = "a.s2.dev";
const DEFAULT_BASIN_ENDPOINT = "{basin}.b.s2.dev";

/**
 * Endpoint configuration for the S2 environment.
 *
 * The basin endpoint host may begin with `{basin}.` (for DNS hosts). When it
 * does not, basin-scoped requests include the `s2-basin` header.
 */
export class S2Endpoints {
	public readonly account: EndpointTemplate;
	public readonly basin: EndpointTemplate;
	/**
	 * When true, include `s2-basin: <name>` header on basin-scoped requests.
	 *
	 * True if and only if the basin endpoint has no `{basin}.` placeholder.
	 */
	public readonly includeBasinHeader: boolean;

	constructor(init?: S2EndpointsInit) {
		if (init === undefined) {
			this.account = new EndpointTemplate({
				endpoint: DEFAULT_ACCOUNT_ENDPOINT,
				allowBasinPlaceholder: false,
			});
			this.basin = new EndpointTemplate({
				endpoint: DEFAULT_BASIN_ENDPOINT,
				allowBasinPlaceholder: true,
			});
		} else {
			if (
				typeof init !== "object" ||
				init === null ||
				typeof init.account !== "string" ||
				typeof init.basin !== "string"
			) {
				throw validationError(
					"Both account and basin endpoints must be provided together",
				);
			}
			this.account = new EndpointTemplate({
				endpoint: init.account,
				allowBasinPlaceholder: false,
			});
			this.basin = new EndpointTemplate({
				endpoint: init.basin,
				allowBasinPlaceholder: true,
			});
			if (this.account.scheme !== this.basin.scheme) {
				throw validationError(
					`Account and basin endpoints must use the same scheme (got ${this.account.scheme} and ${this.basin.scheme})`,
				);
			}
		}
		this.includeBasinHeader = !this.basin.hasBasinPlaceholder;
	}

	public accountBaseUrl(): string {
		return this.account.baseUrl();
	}

	public basinBaseUrl(basin: string): string {
		return this.basin.baseUrl(basin);
	}
}
