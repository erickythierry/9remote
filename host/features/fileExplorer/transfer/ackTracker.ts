// Cumulative-ACK tracker. Receiver records chunks as they arrive (any order,
// possible duplicates) and reports the contiguous high-watermark so the sender
// can ACK many chunks with one message.
export class AckTracker {
  totalSize: number;
  private _contiguous: number;        // bytes confirmed contiguous from offset 0
  private _gaps: Map<number, number>; // offset (beyond contiguous) → length
  private _watermark: number;

  constructor(totalSize: number) {
    this.totalSize = totalSize;
    this._contiguous = 0;
    this._gaps = new Map();
    this._watermark = 0;
  }

  highWatermark(): number { return this._watermark; }

  // Record a received chunk. Returns the new high-watermark if it advanced,
  // or null if this chunk didn't extend the contiguous prefix (gap still open
  // or duplicate).
  mark(offset: number, length: number): number | null {
    if (this.totalSize === 0) return null;
    if (offset < this._contiguous) return null; // duplicate / already covered
    this._gaps.set(offset, length);
    let len: number | undefined;
    while ((len = this._gaps.get(this._contiguous)) !== undefined) {
      this._gaps.delete(this._contiguous);
      this._contiguous += len;
    }
    if (this._contiguous > this._watermark) {
      this._watermark = this._contiguous;
      return this._watermark;
    }
    return null;
  }

  isComplete(): boolean {
    return this._watermark >= this.totalSize;
  }
}
