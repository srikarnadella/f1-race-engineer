// Sequential little-endian reader matching the F1 game UDP spec's packed structs.
class BufferReader {
  constructor(buffer, offset = 0) {
    this.buf = buffer;
    this.offset = offset;
  }

  get remaining() {
    return this.buf.length - this.offset;
  }

  u8() {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  i8() {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16() {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  i16() {
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32() {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64() {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  f32() {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    // The game never sends NaN or Infinity (none in 2.26M captured packets): it
    // means a corrupt packet, which would stick in histories, so drop it whole.
    if (!Number.isFinite(v)) throw new RangeError(`non-finite float at byte ${this.offset - 4}`);
    return v;
  }

  skip(n) {
    this.offset += n;
  }

  array(n, readFn) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = readFn.call(this);
    return out;
  }
}

module.exports = BufferReader;
