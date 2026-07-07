/**
 * FIFO queue with O(1) amortized shift.
 * Plain arrays degrade badly at large depths since shift() memmoves the
 * backing store; this tracks a head index and compacts lazily instead.
 */

/** Dead slots below head must exceed this before compaction is considered. */
const COMPACT_MIN_HEAD = 1024;

export class FifoQueue<T> implements Iterable<T> {
	// Slots below head are dead and set to undefined so items can be GC'd
	private items: (T | undefined)[] = [];
	private head = 0;

	get length(): number {
		return this.items.length - this.head;
	}

	push(item: T): void {
		this.items.push(item);
	}

	/** Remove and return the head item, or undefined if empty. */
	shift(): T | undefined {
		if (this.head >= this.items.length) {
			return undefined;
		}
		const item = this.items[this.head] as T;
		this.items[this.head] = undefined;
		this.head++;
		// Compact once the dead prefix dominates; amortizes to O(1) per shift
		if (this.head >= COMPACT_MIN_HEAD && this.head * 2 >= this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		return item;
	}

	/** Return the head item without removing it, or undefined if empty. */
	peek(): T | undefined {
		return this.items[this.head];
	}

	clear(): void {
		this.items = [];
		this.head = 0;
	}

	/** Remove the first item matching the predicate. Returns true if found. */
	removeFirst(predicate: (item: T) => boolean): boolean {
		for (let i = this.head; i < this.items.length; i++) {
			if (predicate(this.items[i] as T)) {
				this.items.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	/** Test items with queue-relative indices (0 = head). */
	some(predicate: (item: T, index: number) => boolean): boolean {
		for (let i = this.head; i < this.items.length; i++) {
			if (predicate(this.items[i] as T, i - this.head)) {
				return true;
			}
		}
		return false;
	}

	*[Symbol.iterator](): IterableIterator<T> {
		for (let i = this.head; i < this.items.length; i++) {
			yield this.items[i] as T;
		}
	}
}
