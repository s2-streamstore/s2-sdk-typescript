import { abortedError } from "../../error.js";

/**
 * The sessions a transport has opened and that have not ended, so closing
 * the transport can end them before it releases its connections.
 */
export class OpenSessions {
	private readonly closers = new Set<() => unknown>();
	private closed = false;

	/**
	 * Track a session until the returned function is called. Once
	 * {@link closeAll} has been called, throws the error a closed session ends
	 * with, since the session would be ended at once.
	 */
	register(close: () => unknown): () => void {
		if (this.closed) {
			throw abortedError("Transport is closed");
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
		await Promise.allSettled(closers.map(async (close) => close()));
	}
}
