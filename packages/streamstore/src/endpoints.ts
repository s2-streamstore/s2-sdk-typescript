type Scheme = "http" | "https";

const DEFAULT_SCHEME: Scheme = "https";
const DEFAULT_API_PATH = "/v1";
const BASIN_PLACEHOLDER_SENTINEL = "__basin__";

function hasScheme(input: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input);
}

function firstDelimiterIndex(value: string, fromIndex: number): number {
	const slash = value.indexOf("/", fromIndex);
	const query = value.indexOf("?", fromIndex);
	const hash = value.indexOf("#", fromIndex);
	const candidates = [slash, query, hash].filter((idx) => idx !== -1);
	return candidates.length ? Math.min(...candidates) : -1;
}

function hasExplicitPath(input: string): boolean {
	const trimmed = input.trim();
	const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
	const authorityStart = schemeMatch ? schemeMatch[0].length : 0;
	const delim = firstDelimiterIndex(trimmed, authorityStart);
	return delim !== -1 && trimmed[delim] === "/";
}

function normalizeForUrlParsing(input: string): string {
	const trimmed = input.trim();
	const withScheme = hasScheme(trimmed)
		? trimmed
		: `${DEFAULT_SCHEME}://${trimmed}`;
	return withScheme.replaceAll("{basin}", BASIN_PLACEHOLDER_SENTINEL);
}

function asScheme(protocol: string): Scheme {
	const normalized = protocol.replace(":", "").toLowerCase();
	if (normalized === "http" || normalized === "https") return normalized;
	throw new Error(`Unsupported scheme: ${protocol}`);
}

export type EndpointTemplateInit = {
	/**
	 * Endpoint string. May be:
	 * - `host`
	 * - `host:port`
	 * - `https://host[:port][/path]`
	 * - `http://host[:port][/path]`
	 *
	 * For basin endpoints, may include `{basin}` placeholder in hostname and/or path.
	 */
	endpoint: string;
};

export class EndpointTemplate {
	public readonly raw: string;
	public readonly scheme: Scheme;
	public readonly hostTemplate: string;
	public readonly port: string;
	public readonly pathTemplate: string;
	public readonly hasBasinPlaceholder: boolean;
	public readonly explicitPathProvided: boolean;

	constructor({ endpoint }: EndpointTemplateInit) {
		const raw = endpoint.trim();
		if (!raw) {
			throw new Error("Endpoint cannot be empty");
		}

		const explicitPathProvided = hasExplicitPath(raw);
		const parsed = new URL(normalizeForUrlParsing(raw));

		this.raw = raw;
		this.scheme = asScheme(parsed.protocol);
		this.hostTemplate = parsed.hostname.replaceAll(
			BASIN_PLACEHOLDER_SENTINEL,
			"{basin}",
		);
		this.port = parsed.port;

		const parsedPath = parsed.pathname.replaceAll(
			BASIN_PLACEHOLDER_SENTINEL,
			"{basin}",
		);
		const parsedQuery = parsed.search.replaceAll(
			BASIN_PLACEHOLDER_SENTINEL,
			"{basin}",
		);
		const parsedHash = parsed.hash.replaceAll(
			BASIN_PLACEHOLDER_SENTINEL,
			"{basin}",
		);

		this.pathTemplate = explicitPathProvided
			? `${parsedPath}${parsedQuery}${parsedHash}`
			: DEFAULT_API_PATH;
		this.explicitPathProvided = explicitPathProvided;
		this.hasBasinPlaceholder =
			this.raw.includes("{basin}") ||
			this.hostTemplate.includes("{basin}") ||
			this.pathTemplate.includes("{basin}");
	}

	/**
	 * Resolve the template into a base URL string.
	 *
	 * - If `{basin}` appears in the hostname, it is substituted verbatim (basin names are already validated elsewhere).
	 * - If `{basin}` appears in the path/query/hash, it is substituted via `encodeURIComponent`.
	 */
	public baseUrl(basin?: string): string {
		const host = basin
			? this.hostTemplate.replaceAll("{basin}", basin)
			: this.hostTemplate;

		const path = basin
			? this.pathTemplate.replaceAll("{basin}", encodeURIComponent(basin))
			: this.pathTemplate;

		const authority = this.port ? `${host}:${this.port}` : host;
		return `${this.scheme}://${authority}${path}`;
	}
}

export type S2EndpointsInit = {
	/**
	 * Account endpoint (authority with optional scheme/port, optional path).
	 * If no path is present, `/v1` is used.
	 */
	account?: string;
	/**
	 * Basin endpoint (authority with optional scheme/port, optional path).
	 * Supports `{basin}` placeholder anywhere. If no path is present, `/v1` is used.
	 */
	basin?: string;
};

const DEFAULT_ACCOUNT_ENDPOINT = "aws.s2.dev";
const DEFAULT_BASIN_ENDPOINT = "{basin}.b.aws.s2.dev";

/**
 * Endpoint configuration for the S2 environment.
 *
 * This mirrors the Rust SDK's endpoint model, with an additional capability:
 * the basin endpoint may include `{basin}` anywhere (hostname and/or path).
 */
export class S2Endpoints {
	public readonly account: EndpointTemplate;
	public readonly basin: EndpointTemplate;
	/**
	 * When true, include `s2-basin: <name>` header on basin-scoped requests.
	 *
	 * Per project convention: enabled whenever a non-default basin endpoint is provided.
	 */
	public readonly includeBasinHeader: boolean;

	constructor(init?: S2EndpointsInit) {
		this.account = new EndpointTemplate({
			endpoint: init?.account ?? DEFAULT_ACCOUNT_ENDPOINT,
		});
		this.basin = new EndpointTemplate({
			endpoint: init?.basin ?? DEFAULT_BASIN_ENDPOINT,
		});
		this.includeBasinHeader = init?.basin !== undefined;
	}

	public accountBaseUrl(): string {
		return this.account.baseUrl();
	}

	public basinBaseUrl(basin: string): string {
		return this.basin.baseUrl(basin);
	}
}
