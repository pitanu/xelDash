const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

/** Buffers arbitrary TCP chunks and emits complete newline-delimited UTF-8 messages. */
export class LineFramer {
  #buffer = Buffer.alloc(0);
  #maxLineBytes;

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new TypeError("maxLineBytes must be a positive safe integer");
    }
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, incoming])
      : incoming;
    const lines = [];
    let newline;
    while ((newline = this.#buffer.indexOf(0x0a)) !== -1) {
      if (newline > this.#maxLineBytes) throw new RangeError("Stratum message exceeds the maximum line size");
      let line = this.#buffer.subarray(0, newline);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length) lines.push(line.toString("utf8"));
    }
    if (this.#buffer.length > this.#maxLineBytes) {
      throw new RangeError("Stratum message exceeds the maximum line size");
    }
    return lines;
  }
}
