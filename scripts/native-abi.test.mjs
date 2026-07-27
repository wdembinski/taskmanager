import { describe, expect, it } from 'vitest';
import { readModuleAbi } from './native-abi.mjs';

/** A stand-in for a compiled addon: arbitrary binary noise around the symbol name. */
function fakeAddon(symbol) {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x03, 0x00, 0xff, 0xfe]),
    Buffer.from(symbol ? `\0${symbol}\0` : '\0sqlite3_open\0', 'latin1'),
    Buffer.from([0x00, 0x90, 0xc3, 0xff]),
  ]);
}

describe('readModuleAbi', () => {
  it("reads Electron 33's ABI from the registration symbol", () => {
    expect(readModuleAbi(fakeAddon('node_register_module_v130'))).toBe(130);
  });

  it("reads Node 22's ABI — the mismatch that broke the v0.25.0 Linux build", () => {
    expect(readModuleAbi(fakeAddon('node_register_module_v127'))).toBe(127);
  });

  it('returns null when the symbol is absent', () => {
    expect(readModuleAbi(fakeAddon(null))).toBeNull();
  });

  it('survives high bytes that would corrupt a utf8 decode', () => {
    const buffer = Buffer.concat([
      Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xf0, 0x28, 0x8c, 0x28]),
      Buffer.from('node_register_module_v130', 'latin1'),
    ]);
    expect(readModuleAbi(buffer)).toBe(130);
  });
});
