// Browser mirror of host AckTracker — cumulative high-watermark for assembling
// out-of-order download chunks. Pure logic, no DOM.
export class AckTracker {
  totalSize: number;
  private _contiguous: number;
  private _gaps: Map<number, number>;
  watermark: number;

  constructor(totalSize: number) {
    this.totalSize = totalSize;
    this._contiguous = 0;
    this._gaps = new Map();
    this.watermark = 0;
  }

  mark(offset: number, length: number): number | null {
    if (this.totalSize === 0) return null;
    if (offset < this._contiguous) return null;
    this._gaps.set(offset, length);
    while (this._gaps.has(this._contiguous)) {
      const len = this._gaps.get(this._contiguous)!;
      this._gaps.delete(this._contiguous);
      this._contiguous += len;
    }
    if (this._contiguous > this.watermark) {
      this.watermark = this._contiguous;
      return this.watermark;
    }
    return null;
  }

  isComplete(): boolean {
    return this.watermark >= this.totalSize;
  }
}
