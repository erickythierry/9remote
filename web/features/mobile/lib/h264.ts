// Minimal H.264 Annex-B helpers — only what WebCodecs configuration needs.

/** avc1.PPCCLL from the SPS NAL header bytes (profile, constraints, level). */
export function buildCodecString(sps: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export interface ScanResult {
  isKey: boolean;
  spsBytes: Uint8Array | null;
}

/** Walk start codes for the SPS NAL and whether the AU carries an IDR slice. */
export function scanAccessUnit(buf: Uint8Array): ScanResult {
  let isKey = false;
  let spsBytes: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen) {
        const nalType = buf[i + codeLen] & 0x1f;
        if (nalType === 7 && !spsBytes) spsBytes = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, spsBytes };
}
