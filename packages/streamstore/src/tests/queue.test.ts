import { describe, expect, it } from "vitest";
import { FifoQueue } from "../lib/queue.js";

describe("FifoQueue", () => {
	it("shifts in FIFO order", () => {
		const q = new FifoQueue<number>();
		q.push(1);
		q.push(2);
		q.push(3);
		expect(q.shift()).toBe(1);
		expect(q.shift()).toBe(2);
		expect(q.shift()).toBe(3);
		expect(q.shift()).toBeUndefined();
	});

	it("tracks length across push and shift", () => {
		const q = new FifoQueue<number>();
		expect(q.length).toBe(0);
		q.push(1);
		q.push(2);
		expect(q.length).toBe(2);
		q.shift();
		expect(q.length).toBe(1);
		q.shift();
		expect(q.length).toBe(0);
	});

	it("peeks without removing", () => {
		const q = new FifoQueue<number>();
		expect(q.peek()).toBeUndefined();
		q.push(7);
		q.push(8);
		expect(q.peek()).toBe(7);
		expect(q.length).toBe(2);
		q.shift();
		expect(q.peek()).toBe(8);
	});

	it("clears all items", () => {
		const q = new FifoQueue<number>();
		q.push(1);
		q.push(2);
		q.clear();
		expect(q.length).toBe(0);
		expect(q.shift()).toBeUndefined();
	});

	it("removes the first matching item", () => {
		const q = new FifoQueue<number>();
		q.push(1);
		q.push(2);
		q.push(3);
		q.push(2);
		expect(q.removeFirst((x) => x === 2)).toBe(true);
		expect([...q]).toEqual([1, 3, 2]);
		expect(q.removeFirst((x) => x === 99)).toBe(false);
	});

	it("removeFirst accounts for shifted head", () => {
		const q = new FifoQueue<number>();
		q.push(5);
		q.push(5);
		q.push(6);
		q.shift();
		expect(q.removeFirst((x) => x === 5)).toBe(true);
		expect([...q]).toEqual([6]);
	});

	it("some uses queue-relative indices", () => {
		const q = new FifoQueue<string>();
		q.push("a");
		q.push("b");
		q.push("c");
		q.shift();
		const seen: Array<[string, number]> = [];
		q.some((item, index) => {
			seen.push([item, index]);
			return false;
		});
		expect(seen).toEqual([
			["b", 0],
			["c", 1],
		]);
		expect(q.some((_, index) => index > 0)).toBe(true);
		expect(q.some(() => false)).toBe(false);
	});

	it("iterates from head to tail", () => {
		const q = new FifoQueue<number>();
		q.push(1);
		q.push(2);
		q.push(3);
		q.shift();
		expect([...q]).toEqual([2, 3]);
	});

	it("preserves order and contents through compaction", () => {
		const q = new FifoQueue<number>();
		const total = 10_000;
		for (let i = 0; i < total; i++) {
			q.push(i);
		}
		// Shift past the compaction threshold while pushing more
		for (let i = 0; i < total; i++) {
			expect(q.shift()).toBe(i);
			q.push(total + i);
		}
		expect(q.length).toBe(total);
		expect(q.peek()).toBe(total);
		for (let i = 0; i < total; i++) {
			expect(q.shift()).toBe(total + i);
		}
		expect(q.length).toBe(0);
		expect(q.shift()).toBeUndefined();
	});
});
