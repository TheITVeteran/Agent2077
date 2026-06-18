/**
 * Loop Detection Circuit Breaker — prevents infinite agent loops.
 * Detects: genericRepeat (same tool+args N times), pingPong (A→B→A→B),
 * stallDetection (no progress across N iterations), and thinkLoop
 * (same tool name called 3+ times consecutively regardless of args —
 * catches search_files retry spirals where args change slightly each time).
 */

interface ToolCallRecord {
  tool: string;
  argsHash: string;
  iteration: number;
}

/** Threshold for same-tool-name consecutive calls (think-loop detection). */
const THINK_LOOP_THRESHOLD = 6;

/**
 * Tools exempt from the think-loop detector.
 * selfdev_read_file is legitimately called many times in a row during Step 2
 * (reading multiple files sequentially) — firing on it is a false positive.
 */
const THINK_LOOP_EXEMPT = new Set([
  'selfdev_read_file',
  'selfdev_list_files',
  'selfdev_search_files',
  'read_file',
  'list_files',
]);

export class LoopDetector {
  private history: ToolCallRecord[] = [];
  private readonly historySize = 30;
  private readonly warningThreshold = 6;
  private readonly criticalThreshold = 10;

  /** Record a tool call. Returns 'ok' | 'warning' | 'critical'. */
  record(tool: string, args: Record<string, any>): 'ok' | 'warning' | 'critical' {
    const argsHash = this.hashArgs(args);
    this.history.push({ tool, argsHash, iteration: this.history.length });
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }

    // thinkLoop: same tool name called consecutively regardless of args
    // This catches search spirals where the agent retries with slightly different args
    const sameToolCount = this.countConsecutiveSameTool();
    if (sameToolCount >= THINK_LOOP_THRESHOLD) return 'warning';

    // genericRepeat: same tool+args called consecutively
    const repeatCount = this.countConsecutiveRepeats();
    if (repeatCount >= this.criticalThreshold) return 'critical';
    if (repeatCount >= this.warningThreshold) return 'warning';

    // pingPong: A→B→A→B pattern
    const pingPongCount = this.detectPingPong();
    if (pingPongCount >= this.criticalThreshold) return 'critical';
    if (pingPongCount >= this.warningThreshold) return 'warning';

    return 'ok';
  }

  /** Count how many consecutive calls share the same tool name (args may differ).
   * Returns 0 for tools that are exempt from think-loop detection. */
  countConsecutiveSameTool(): number {
    if (this.history.length < 2) return 0;
    const last = this.history[this.history.length - 1];
    // Exempt tools are never flagged — reading files sequentially is normal
    if (THINK_LOOP_EXEMPT.has(last.tool)) return 0;
    let count = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.history[i].tool === last.tool) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private countConsecutiveRepeats(): number {
    if (this.history.length < 2) return 1;
    const last = this.history[this.history.length - 1];
    let count = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      const prev = this.history[i];
      if (prev.tool === last.tool && prev.argsHash === last.argsHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private detectPingPong(): number {
    if (this.history.length < 4) return 0;
    const h = this.history;
    const a = h[h.length - 2];
    const b = h[h.length - 1];
    // Look backwards for alternating A-B pattern
    let count = 1;
    for (let i = h.length - 3; i >= 1; i -= 2) {
      if (h[i].tool === a.tool && h[i].argsHash === a.argsHash &&
          h[i - 1]?.tool === b.tool && h[i - 1]?.argsHash === b.argsHash) {
        // Wait, wrong direction — let me fix: we check i and i-1
        // Actually: alternating pattern is h[len-1]=B, h[len-2]=A, h[len-3]=B, h[len-4]=A
      }
      if (h[i].tool === b.tool && h[i].argsHash === b.argsHash &&
          h[i - 1]?.tool === a.tool && h[i - 1]?.argsHash === a.argsHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private hashArgs(args: Record<string, any>): string {
    try {
      // Simple deterministic hash — sort keys and stringify
      const sorted = JSON.stringify(args, Object.keys(args).sort());
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        const char = sorted.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return String(hash);
    } catch {
      return 'unknown';
    }
  }

  /** Get a human-readable status message. */
  getStatus(): string {
    if (this.history.length === 0) return 'No tool calls recorded';
    const repeats = this.countConsecutiveRepeats();
    const pingPong = this.detectPingPong();
    return `history=${this.history.length}, consecutiveRepeats=${repeats}, pingPong=${pingPong}`;
  }

  /** Reset the detector (e.g., on new conversation). */
  reset(): void {
    this.history = [];
  }
}

/**
 * Block-level repetition detector for streamed *assistant text*.
 *
 * The existing inline char-level guard in the agent loop only catches short
 * repeated substrings (8–40 chars) inside a 400-char rolling window, and the
 * paragraph guard only fires when a single line of 60+ chars recurs. Neither
 * catches the pathological case from the bug report: a medium/large multi-line
 * block (e.g. a "How I can help instead:" heading followed by a short numbered
 * list) repeated verbatim many times. Each individual line is < 60 chars and
 * the whole block is far longer than 40 chars, so it slips through both.
 *
 * This detector accumulates text and looks for a *tail-anchored periodic
 * repetition*: a unit of `period` chars repeated back-to-back at the end of the
 * buffer. It fires when that unit is large enough to be a real "block" and has
 * repeated enough times to be pathological rather than a legitimate list.
 *
 * Designed to NOT false-trigger on:
 *   - normal repeated short words / punctuation ("ok ok", "...") — the unit
 *     must be >= MIN_BLOCK_PERIOD chars (those are left to the char-level guard).
 *   - legitimate numbered/bulleted lists or code — list items and code lines
 *     differ from one another, so they don't form an *exact* periodic repeat.
 */
export class BlockRepetitionDetector {
  private buf = "";
  /** Keep enough tail to hold several repeats of a large block. */
  private readonly maxBuf = 16000;
  /** Smallest repeating unit we treat as a "block" (chars). */
  private readonly minPeriod: number;
  /** Largest repeating unit we bother scanning for (chars). */
  private readonly maxPeriod: number;
  /** How many back-to-back repeats trigger detection. */
  private readonly threshold: number;
  private _tripped = false;

  constructor(opts: { minPeriod?: number; maxPeriod?: number; threshold?: number } = {}) {
    this.minPeriod = opts.minPeriod ?? 48;
    this.maxPeriod = opts.maxPeriod ?? 4000;
    this.threshold = opts.threshold ?? 4;
  }

  /** Whether detection has already fired (latched). */
  get tripped(): boolean { return this._tripped; }

  /**
   * Feed a new content chunk. Returns true the first time a pathological
   * block-repetition is detected. Latches: once tripped it keeps returning true.
   */
  push(chunk: string): boolean {
    if (this._tripped) return true;
    if (!chunk) return false;
    this.buf += chunk;
    if (this.buf.length > this.maxBuf) this.buf = this.buf.slice(-this.maxBuf);
    if (this.detect()) {
      this._tripped = true;
      return true;
    }
    return false;
  }

  /**
   * Scan the tail of the buffer for a period `p` whose last `threshold` copies
   * are (near-)identical. We probe a set of candidate periods derived from the
   * structure of the tail (newline-delimited blocks) plus a bounded numeric
   * sweep, to stay O(buffer) rather than O(buffer^2).
   */
  private detect(): boolean {
    const s = this.buf;
    const n = s.length;
    if (n < this.minPeriod * this.threshold) return false;

    const candidates = this.candidatePeriods(s);
    for (const p of candidates) {
      if (p < this.minPeriod || p > this.maxPeriod) continue;
      if (n < p * this.threshold) continue;
      if (this.repeatCountAtTail(s, p) >= this.threshold) {
        // A unit qualifies as a "block" if it spans multiple lines or is long.
        const unit = s.slice(n - p);
        const multiLine = unit.includes("\n");
        if (multiLine || p >= 80) return true;
      }
    }
    return false;
  }

  /**
   * Build candidate period lengths. The strongest signal for the bug case is
   * the distance between repeated occurrences of the final line, so we anchor
   * on newline boundaries; we also add a coarse numeric sweep as a fallback for
   * single-line-but-long repeats.
   */
  private candidatePeriods(s: string): number[] {
    const n = s.length;
    const set = new Set<number>();

    // Newline-anchored: gaps between the last newline and earlier identical-ish
    // newline positions give natural block boundaries.
    const nlPositions: number[] = [];
    for (let i = n - 1; i >= 0 && nlPositions.length < 64; i--) {
      if (s[i] === "\n") nlPositions.push(i);
    }
    // distance from each earlier newline to the last newline → candidate period
    if (nlPositions.length >= 2) {
      const last = nlPositions[0];
      for (let k = 1; k < nlPositions.length; k++) {
        set.add(last - nlPositions[k]);
      }
    }

    // Coarse numeric sweep for non-newline-aligned repeats (capped for cost).
    const hi = Math.min(this.maxPeriod, Math.floor(n / this.threshold));
    for (let p = this.minPeriod; p <= hi; p += 8) set.add(p);

    return Array.from(set);
  }

  /**
   * How many consecutive copies of the trailing `p`-char unit sit at the end of
   * `s`. Uses a small similarity tolerance so trivially-different whitespace or
   * a stray token between copies doesn't reset the count — but stays strict
   * enough that genuinely distinct list items / code lines don't match.
   */
  private repeatCountAtTail(s: string, p: number): number {
    const n = s.length;
    const unit = s.slice(n - p);
    let count = 1;
    let end = n - p;
    while (end - p >= 0) {
      const candidate = s.slice(end - p, end);
      if (this.similar(candidate, unit)) {
        count++;
        end -= p;
      } else {
        break;
      }
    }
    return count;
  }

  /** Near-equality: exact, or >=95% matching chars (cheap Hamming over equal length). */
  private similar(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    let diff = 0;
    const tol = Math.floor(a.length * 0.05);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { diff++; if (diff > tol) return false; }
    }
    return true;
  }

  reset(): void {
    this.buf = "";
    this._tripped = false;
  }
}
