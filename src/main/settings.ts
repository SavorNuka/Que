import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { RestrictionSettings, Settings } from '@shared/types';
import { DEFAULT_RESTRICTIONS, configure as configureRestrictions } from './restrictions';
import type { PinRecord } from './restrictions';

/**
 * Settings live in userData/settings.json.
 *
 * API keys are OPTIONAL (ARCHITECTURE §10) and are encrypted at rest with
 * safeStorage (DPAPI on Windows). They are never included in the object
 * returned to the renderer — only `hasTmdbKey` / `hasWyzieKey` booleans.
 */

interface StoredSettings extends Settings {
  tmdbKeyEnc: string | null;
  wyzieKeyEnc: string | null;
  /** True when the values above are base64 ciphertext, false when plaintext. */
  keysEncrypted: boolean;
  /** §23. The PIN hash lives here and is never returned to the renderer. */
  restrictions: RestrictionSettings;
  pin: PinRecord | null;
}

const DEFAULTS: StoredSettings = {
  preferredSubtitleLanguage: 'en',
  preferredLyricsLanguage: 'en',
  autoFetchMetadata: true,
  groupedBrowseVideo: false,
  groupedBrowseAudio: true,
  activeSkin: 'classic',
  theme: 'system',
  server: { enabled: true, port: 8723, lanEnabled: false },
  hasTmdbKey: false,
  hasWyzieKey: false,
  tmdbKeyEnc: null,
  wyzieKeyEnc: null,
  keysEncrypted: false,
  restrictions: DEFAULT_RESTRICTIONS,
  pin: null,
};

let cache: StoredSettings | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function encrypt(plain: string): { value: string; encrypted: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(plain).toString('base64'), encrypted: true };
  }
  console.warn('[settings] OS encryption unavailable — API key stored in plaintext');
  return { value: plain, encrypted: false };
}

function decrypt(stored: string | null, encrypted: boolean): string | null {
  if (!stored) return null;
  if (!encrypted) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    console.warn('[settings] could not decrypt a stored key — clearing it');
    return null;
  }
}

export function load(): StoredSettings {
  if (cache) return cache;
  const applied = (s: StoredSettings): StoredSettings => {
    configureRestrictions(s.restrictions, s.pin);
    return s;
  };
  const p = settingsPath();
  if (!existsSync(p)) {
    cache = applied({ ...DEFAULTS });
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<StoredSettings>;
    cache = applied({
      ...DEFAULTS,
      ...parsed,
      server: { ...DEFAULTS.server, ...parsed.server },
      restrictions: { ...DEFAULT_RESTRICTIONS, ...parsed.restrictions },
    });
  } catch (e) {
    console.error('[settings] unreadable settings.json, using defaults:', e);
    cache = applied({ ...DEFAULTS });
  }
  return cache;
}

/** Atomic write: temp file then rename, so a crash can't truncate settings. */
function persist(s: StoredSettings): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, p);
  cache = s;
  // Push restriction state into the enforcement module (§23).
  configureRestrictions(s.restrictions, s.pin);
}

/** The renderer-facing view. Key material is deliberately absent. */
export function publicSettings(): Settings {
  const s = load();
  return {
    preferredSubtitleLanguage: s.preferredSubtitleLanguage,
    preferredLyricsLanguage: s.preferredLyricsLanguage,
    autoFetchMetadata: s.autoFetchMetadata,
    groupedBrowseVideo: s.groupedBrowseVideo,
    groupedBrowseAudio: s.groupedBrowseAudio,
    activeSkin: s.activeSkin,
    theme: s.theme,
    server: s.server,
    hasTmdbKey: s.tmdbKeyEnc !== null,
    hasWyzieKey: s.wyzieKeyEnc !== null,
  };
}

export function update(patch: Partial<Settings>): Settings {
  const s = load();
  persist({ ...s, ...patch, server: { ...s.server, ...patch.server } });
  return publicSettings();
}

export function setKey(which: 'tmdb' | 'wyzie', value: string | null): Settings {
  const s = load();
  const field = which === 'tmdb' ? 'tmdbKeyEnc' : 'wyzieKeyEnc';
  if (value === null || value.trim() === '') {
    persist({ ...s, [field]: null });
  } else {
    const { value: enc, encrypted } = encrypt(value.trim());
    persist({ ...s, [field]: enc, keysEncrypted: encrypted });
  }
  return publicSettings();
}

/** Main-process only. Never send the result over IPC. */
export function getKey(which: 'tmdb' | 'wyzie'): string | null {
  const s = load();
  return decrypt(which === 'tmdb' ? s.tmdbKeyEnc : s.wyzieKeyEnc, s.keysEncrypted);
}

// -------------------------------------------------------------- §23

export function restrictions(): RestrictionSettings {
  return load().restrictions;
}

export function setRestrictions(patch: Partial<RestrictionSettings>): RestrictionSettings {
  const s = load();
  // pinSet is derived from whether a PIN record exists — not settable directly.
  const { pinSet: _ignored, ...rest } = patch;
  const next = { ...s.restrictions, ...rest, pinSet: s.pin !== null };
  persist({ ...s, restrictions: next });
  return next;
}

/** Main-process only. */
export function pinRecord(): PinRecord | null {
  return load().pin;
}

export function setPinRecord(record: PinRecord | null): RestrictionSettings {
  const s = load();
  const next = { ...s.restrictions, pinSet: record !== null };
  persist({ ...s, pin: record, restrictions: next });
  return next;
}
