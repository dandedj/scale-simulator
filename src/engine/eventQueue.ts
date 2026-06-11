/**
 * Binary min-heap priority queue keyed on simulation time.
 *
 * The simulation is a discrete-event system: everything that will happen is
 * an event scheduled at a virtual timestamp. Each animation frame the engine
 * advances the virtual clock and drains every event that has come due.
 */

export interface ScheduledEvent {
  /** Virtual simulation time (ms) at which the event fires. */
  time: number;
  /** Insertion order tiebreaker for stable, deterministic ordering. */
  seq: number;
  /** Set false to cancel without the O(n) cost of removal. */
  active: boolean;
  fire(): void;
}

export class EventQueue {
  private heap: ScheduledEvent[] = [];
  private seqCounter = 0;

  schedule(time: number, fire: () => void): ScheduledEvent {
    const ev: ScheduledEvent = { time, seq: this.seqCounter++, active: true, fire };
    this.heap.push(ev);
    this.bubbleUp(this.heap.length - 1);
    return ev;
  }

  /** Earliest pending event time, or Infinity if empty. */
  peekTime(): number {
    // Skip over cancelled events lazily.
    while (this.heap.length > 0 && !this.heap[0].active) this.popRaw();
    return this.heap.length > 0 ? this.heap[0].time : Infinity;
  }

  /** Pop the next active event due at or before `time`, or null. */
  popDue(time: number): ScheduledEvent | null {
    while (this.heap.length > 0) {
      const top = this.heap[0];
      if (!top.active) {
        this.popRaw();
        continue;
      }
      if (top.time > time) return null;
      return this.popRaw();
    }
    return null;
  }

  clear(): void {
    this.heap.length = 0;
    this.seqCounter = 0;
  }

  get size(): number {
    return this.heap.length;
  }

  private popRaw(): ScheduledEvent {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private less(i: number, j: number): boolean {
    const a = this.heap[i];
    const b = this.heap[j];
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = tmp;
  }
}
