import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('produces an 11-character string', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('uses only URL-safe base64url characters', () => {
    const id = generatePublicId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('does not collide across a high volume of generations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(50000);
  });
});
