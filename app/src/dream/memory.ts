// app/src/dream/memory.ts
// The dream's MEMORY — what turns asset selection into dream RECURRENCE.
//
// As the dream surfaces assets, the concrete ENTITIES in them (RAM++ open-set tags baked offline:
// clock, staircase, bird, hands, moon…) accumulate into a decaying weighted set. The dreamwalker
// then leans toward candidates that ECHO what is currently remembered, so motifs return and
// transform across a dream — a leitmotif, not just good-looking selection. The influence is
// BOUNDED (capped per entity, so it never fixates) and RELAXES (every beat decays, so old motifs
// fade and new ones emerge) — the same "seeded spine that bends and relaxes" model as steering.
//
// Pure + deterministic: memory is driven only by the (seeded) sequence of observed entities and a
// per-beat decay, so the same seed yields the same recurrence. No DOM, no randomness of its own.

export interface DreamMemoryConfig {
  /** Weight added to an entity each time it is observed. */
  addWeight: number;
  /** Per-beat multiplicative decay applied to every weight (0..1) — how fast motifs fade. */
  decay: number;
  /** Maximum weight any one entity can reach (prevents a single motif from dominating). */
  cap: number;
  /** Entities below this weight are forgotten. */
  prune: number;
  /** Hard bound on how many entities are remembered at once (keeps the strongest). */
  maxEntities: number;
}

export const DEFAULT_MEMORY_CONFIG: DreamMemoryConfig = {
  addWeight: 1.0,
  decay: 0.82, // a motif observed once is mostly gone after ~5–6 beats if never seen again
  cap: 2.5, // a motif seen repeatedly saturates here (bounded — no fixation)
  prune: 0.06,
  maxEntities: 48,
};

export class DreamMemory {
  private weights = new Map<string, number>();

  constructor(private readonly cfg: DreamMemoryConfig = DEFAULT_MEMORY_CONFIG) {}

  /** Advance one beat: decay every remembered weight and forget the faint ones. */
  decayStep(): void {
    for (const [k, w] of this.weights) {
      const nw = w * this.cfg.decay;
      if (nw < this.cfg.prune) this.weights.delete(k);
      else this.weights.set(k, nw);
    }
  }

  /** Fold an observed asset's entities into memory (call after decayStep on the same beat). */
  observe(entities: string[] | undefined): void {
    if (!entities || entities.length === 0) return;
    for (const e of entities) {
      this.weights.set(e, Math.min(this.cfg.cap, (this.weights.get(e) ?? 0) + this.cfg.addWeight));
    }
    if (this.weights.size > this.cfg.maxEntities) {
      // Keep the strongest maxEntities; tie-break by name so pruning is deterministic.
      const ranked = [...this.weights.entries()].sort((a, b) =>
        b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
      );
      this.weights = new Map(ranked.slice(0, this.cfg.maxEntities));
    }
  }

  /** Recurrence score for a candidate: how strongly its entities echo current memory (>= 0). */
  echo(entities: string[] | undefined): number {
    if (!entities || this.weights.size === 0) return 0;
    let s = 0;
    for (const e of entities) s += this.weights.get(e) ?? 0;
    return s;
  }

  /** The strongest remembered entity (a candidate for a deliberate return), or undefined. */
  dominant(): string | undefined {
    let best: string | undefined;
    let bw = 0;
    for (const [k, w] of this.weights) {
      // Deterministic tie-break by name.
      if (w > bw || (w === bw && best !== undefined && k < best)) {
        bw = w;
        best = k;
      }
    }
    return best;
  }

  size(): number {
    return this.weights.size;
  }

  reset(): void {
    this.weights.clear();
  }

  /** Read-only snapshot for tests/inspection. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.weights);
  }
}
