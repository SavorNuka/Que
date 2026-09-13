import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, IPC_CHANNELS, type IpcChannel } from '../src/shared/ipc-contract';
import { argSchemas } from '../src/shared/schemas';

/**
 * The IPC boundary is where the renderer stops being trusted (ARCHITECTURE
 * §17). M0 shipped it with no tests at all, which AAR-M0 P3 recorded as a gap;
 * this closes it.
 *
 * Two things are checked: that the contract, the schemas and the runtime
 * channel list cannot drift apart, and that each schema actually rejects the
 * malformed input it exists to reject.
 */

describe('contract integrity', () => {
  it('has a schema for every channel', () => {
    const missing = IPC_CHANNELS.filter((c) => !(c in argSchemas));
    expect(missing).toEqual([]);
  });

  it('has no schema for a channel that does not exist', () => {
    const extra = Object.keys(argSchemas).filter(
      (k) => !(IPC_CHANNELS as readonly string[]).includes(k)
    );
    expect(extra).toEqual([]);
  });

  it('lists no duplicate channels', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  });

  it('lists no duplicate events', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});

const parse = (channel: IpcChannel, args: unknown[]): ReturnType<(typeof argSchemas)[IpcChannel]['safeParse']> =>
  argSchemas[channel].safeParse(args);

const accepts = (channel: IpcChannel, args: unknown[]): boolean => parse(channel, args).success;

describe('argument validation', () => {
  it('accepts a well-formed library:list call', () => {
    expect(
      accepts('library:list', [{ match: 'all' }, { key: 'title', dir: 'asc' }, null])
    ).toBe(true);
  });

  it.each([
    ['a non-integer id', 'library:get', [1.5]],
    ['a negative id', 'library:get', [-1]],
    ['a zero id', 'library:get', [0]],
    ['a string id', 'library:get', ['1']],
    ['no arguments at all', 'library:get', []],
    ['too many arguments', 'library:get', [1, 2]],
  ] as [string, IpcChannel, unknown[]][])('rejects %s', (_label, channel, args) => {
    expect(accepts(channel, args)).toBe(false);
  });

  it('rejects an unknown media kind', () => {
    expect(accepts('sources:pickFolder', ['document'])).toBe(false);
    expect(accepts('sources:pickFolder', ['video'])).toBe(true);
  });

  it('rejects an unknown sort key', () => {
    expect(
      accepts('library:list', [{ match: 'all' }, { key: 'filename; DROP TABLE media', dir: 'asc' }, null])
    ).toBe(false);
  });

  /**
   * Sort keys are the one place a value reaches SQL as an identifier rather
   * than a bound parameter, so the enum is load-bearing.
   */
  it('rejects every sort key outside the enum', () => {
    for (const key of ['path', 'id', 'user_rating', '', '*']) {
      expect(accepts('library:list', [{ match: 'all' }, { key, dir: 'asc' }, null])).toBe(false);
    }
  });

  it('rejects an out-of-range rating', () => {
    expect(accepts('library:setRating', [1, 11])).toBe(false);
    expect(accepts('library:setRating', [1, -1])).toBe(false);
    expect(accepts('library:setRating', [1, 8.5])).toBe(true);
    expect(accepts('library:setRating', [1, null])).toBe(true);
  });

  it('caps an import batch instead of accepting unbounded input', () => {
    expect(accepts('library:import', [Array.from({ length: 10 }, () => '/x.mp4')])).toBe(true);
    expect(accepts('library:import', [Array.from({ length: 5000 }, () => '/x.mp4')])).toBe(false);
    expect(accepts('library:import', [[]])).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(accepts('sources:set', ['video', ''])).toBe(false);
  });

  it('accepts a Windows path', () => {
    expect(accepts('sources:set', ['video', 'D:\\Media\\Movies'])).toBe(true);
  });

  it('bounds a search query', () => {
    expect(accepts('search:global', ['alien', 50])).toBe(true);
    expect(accepts('search:global', ['x'.repeat(5000), 50])).toBe(false);
    expect(accepts('search:global', ['alien', 100_000])).toBe(false);
  });

  it('bounds a playback position', () => {
    expect(accepts('player:progress', [1, 60_000])).toBe(true);
    expect(accepts('player:progress', [1, -5])).toBe(false);
    expect(accepts('player:progress', [1, 999_999_999])).toBe(false);
  });

  it('requires a scan kind to be a kind or explicitly null', () => {
    expect(accepts('library:scan', [null, false])).toBe(true);
    expect(accepts('library:scan', ['video', true])).toBe(true);
    expect(accepts('library:scan', ['everything', false])).toBe(false);
    expect(accepts('library:scan', [undefined, false])).toBe(false);
  });

  /** §23 — a PIN is digits only, so a pasted passphrase is rejected outright. */
  it('constrains the restriction PIN', () => {
    expect(accepts('restrictions:setPin', ['1234'])).toBe(true);
    expect(accepts('restrictions:setPin', ['123'])).toBe(false);
    expect(accepts('restrictions:setPin', ['1234567890123'])).toBe(false);
    expect(accepts('restrictions:setPin', ['abcd'])).toBe(false);
    expect(accepts('restrictions:setPin', [null])).toBe(true);
  });

  it('will not let the renderer claim a PIN is set', () => {
    // pinSet is derived from whether a PIN record exists; accepting it here
    // would let the UI lie about its own lock state.
    const result = parse('restrictions:set', [{ enabled: true, pinSet: true }]);
    expect(result.success).toBe(true);
    expect(result.success && 'pinSet' in (result.data[0] as object)).toBe(false);
  });

  it('rejects a restriction age outside the mapped range', () => {
    expect(accepts('restrictions:set', [{ maxAge: 13 }])).toBe(true);
    expect(accepts('restrictions:set', [{ maxAge: 99 }])).toBe(false);
    expect(accepts('restrictions:set', [{ maxAge: -1 }])).toBe(false);
  });

  it('rejects a privileged server port', () => {
    expect(accepts('settings:set', [{ server: { enabled: true, port: 8723, lanEnabled: false } }])).toBe(true);
    expect(accepts('settings:set', [{ server: { enabled: true, port: 80, lanEnabled: false } }])).toBe(false);
    expect(accepts('settings:set', [{ server: { enabled: true, port: 99999, lanEnabled: false } }])).toBe(false);
  });

  it('rejects an unknown provider key name', () => {
    expect(accepts('settings:setKey', ['tmdb', 'abc'])).toBe(true);
    expect(accepts('settings:setKey', ['openai', 'abc'])).toBe(false);
  });

  it('accepts only hex colours for a group accent', () => {
    const screen = { layout: 'grid', sortBy: 'title', sections: ['hero'] };
    expect(accepts('groups:setScreen', [1, { ...screen, accent: '#ff0055' }])).toBe(true);
    expect(accepts('groups:setScreen', [1, { ...screen, accent: 'red' }])).toBe(false);
    expect(
      accepts('groups:setScreen', [1, { ...screen, accent: 'javascript:alert(1)' }])
    ).toBe(false);
  });

  it('rejects an unknown group layout', () => {
    expect(
      accepts('groups:setScreen', [1, { layout: 'freeform', sortBy: 'title', sections: [] }])
    ).toBe(false);
  });

  it('applies the documented default for a missing match mode', () => {
    const result = parse('library:list', [{}, { key: 'title', dir: 'asc' }, null]);
    expect(result.success).toBe(true);
    expect(result.success && (result.data[0] as { match: string }).match).toBe('all');
  });

  it('rejects extra arguments on a no-argument channel', () => {
    expect(accepts('app:info', [])).toBe(true);
    expect(accepts('app:info', ['surprise'])).toBe(false);
  });
});
