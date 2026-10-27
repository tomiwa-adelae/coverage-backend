import { base32Decode, base32Encode, hotp, totp, verifyTotp } from './totp';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" with SHA-1.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('hello coverage');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('matches the RFC 6238 test vectors (8 digits)', () => {
    expect(totp(SECRET, 59_000, 8)).toBe('94287082');
    expect(totp(SECRET, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(SECRET, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totp(SECRET, 20_000_000_000_000, 8)).toBe('65353130');
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    expect(hotp(SECRET, 0)).toBe('755224');
    expect(hotp(SECRET, 9)).toBe('520489');
  });

  it('accepts one step of clock drift and rejects more', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(SECRET, totp(SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, now + 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, now - 90_000), now)).toBe(false);
    expect(verifyTotp(SECRET, 'abc123', now)).toBe(false);
  });
});
