import { S2Error } from "../../error.js";

/**
 * The sessions a transport has opened and that have not ended, so closing
 * the transport can end them before it releases its connections.
 */
export class OpenSessions {
	private readonly closers = new Set<() => Promise<void>>();
	private closed = false;

	/**
	 * Track a session until the returned function is called.
	 * Throws once {@link closeAll} has been called.
	 */
	register(close: () => Promise<void>): () => void {
		if (this.closed) {
			throw new S2Error({
				message: "Transport is closed",
				status: 400,
				origin: "sdk",
			});
		}
		this.closers.add(close);
		return () => {
			this.closers.delete(close);
		};
	}

	/** Close every tracked session, ignoring their errors. */
	async closeAll(): Promise<void> {
		this.closed = true;
		const closers = [...this.closers];
		this.closers.clear();
		await Promise.all(closers.map((close) => close().catch(() => {})));
	}
}
