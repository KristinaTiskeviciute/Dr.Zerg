import { Color } from '../core/types';
import type { CpuSpec, FromWorker, ToWorker } from './cpu-worker';
import { BoardSnapshot, Outcome } from './protocol';

export type { CpuSpec };

export interface CpuRunnerHandlers {
  onBoard(id: string, snap: BoardSnapshot): void;
  onGarbage(id: string, colors: Color[], firstColors: Color[]): void;
  onOver(id: string, outcome: Outcome): void;
}

/**
 * The CPU players this browser plays in an online match, running in a worker. Times passed in
 * are performance.now() values; the worker gets them as epoch times.
 */
export class CpuRunner {
  private worker: Worker | null = null;
  private ids = new Set<string>();
  private lastSync = '';

  constructor(private readonly handlers: CpuRunnerHandlers) {}

  /** A new round: play these CPUs (none = stop), starting at `startAt`. */
  start(cpus: CpuSpec[], startAt: number): void {
    this.ids = new Set(cpus.map(c => c.id));
    this.lastSync = '';
    if (cpus.length === 0) return this.stop();
    this.post({ type: 'start', cpus, startAt: epoch(startAt) });
  }

  /** Hold (pause, waiting, round over) or play from `startAt`. Only sends when something changed. */
  sync(hold: boolean, startAt: number): void {
    if (this.ids.size === 0) return;
    const key = `${hold}:${Math.round(startAt)}`;
    if (key === this.lastSync) return;
    this.lastSync = key;
    this.post({ type: 'sync', hold, startAt: epoch(startAt) });
  }

  garbage(id: string, colors: Color[]): void {
    if (this.ids.has(id)) this.post({ type: 'garbage', id, colors });
  }

  runs(id: string): boolean {
    return this.ids.has(id);
  }

  stop(): void {
    this.ids.clear();
    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker);
  }

  private post(msg: ToWorker): void {
    if (!this.worker) {
      this.worker = new Worker(new URL('./cpu-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (!this.ids.has(m.id)) return; // from a round that's over
        if (m.type === 'board') this.handlers.onBoard(m.id, m.snap);
        else if (m.type === 'garbage') this.handlers.onGarbage(m.id, m.colors, m.firstColors);
        else this.handlers.onOver(m.id, m.outcome);
      };
    }
    this.worker.postMessage(msg);
  }
}

const epoch = (t: number) => performance.timeOrigin + t;
