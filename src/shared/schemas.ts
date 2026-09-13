/**
 * Runtime validation for every IPC argument list.
 * The renderer is untrusted: nothing reaches the database or the filesystem
 * without passing through here first (ARCHITECTURE §17).
 */

import { z } from 'zod';
import type { IpcChannel } from './ipc-contract';

const kind = z.enum(['video', 'audio']);
const id = z.number().int().positive();
const groupType = z.enum(['artist', 'album', 'series', 'season', 'saga', 'collection', 'custom']);

export const filterSpecSchema = z.object({
  q: z.string().max(500).optional(),
  kind: kind.optional(),
  genres: z.array(z.string().max(80)).max(50).optional(),
  years: z.tuple([z.number().int(), z.number().int()]).optional(),
  rating: z
    .object({
      min: z.number().min(0).max(10).optional(),
      max: z.number().min(0).max(10).optional(),
      unrated: z.boolean().optional(),
    })
    .optional(),
  artists: z.array(z.string().max(200)).max(50).optional(),
  albums: z.array(z.string().max(200)).max(50).optional(),
  series: z.array(z.string().max(200)).max(50).optional(),
  playlistId: id.optional(),
  groupId: id.optional(),
  groupType: groupType.optional(),
  inAnyGroup: z.boolean().optional(),
  watched: z.enum(['yes', 'no', 'in-progress']).optional(),
  hasSubs: z.boolean().optional(),
  hasLyrics: z.boolean().optional(),
  hasArtwork: z.boolean().optional(),
  codecs: z.array(z.string().max(40)).max(30).optional(),
  containers: z.array(z.string().max(40)).max(30).optional(),
  needsRemux: z.boolean().optional(),
  duration: z.tuple([z.number(), z.number()]).optional(),
  addedWithin: z.string().regex(/^\d+[dmy]$/).optional(),
  missing: z.boolean().optional(),
  fields: z
    .array(
      z.object({
        key: z.string().max(100),
        op: z.enum(['eq', 'contains', 'exists']),
        value: z.string().max(500).optional(),
      })
    )
    .max(20)
    .optional(),
  match: z.enum(['all', 'any']).default('all'),
});

export const sortSpecSchema = z.object({
  key: z.enum([
    'title',
    'year',
    'rating',
    'added',
    'played',
    'playCount',
    'duration',
    'artist',
    'album',
  ]),
  dir: z.enum(['asc', 'desc']),
});

export const groupScreenSchema = z.object({
  displayName: z.string().max(200).optional(),
  tagline: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  hero: z
    .object({
      image: z.string().max(1024).optional(),
      focal: z.enum(['center', 'top', 'bottom']).optional(),
      overlay: z.number().min(0).max(1).optional(),
      blur: z.number().min(0).max(64).optional(),
      height: z.enum(['compact', 'standard', 'full']).optional(),
    })
    .optional(),
  poster: z.string().max(1024).optional(),
  logo: z.string().max(1024).optional(),
  backdrop: z.string().max(1024).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  layout: z.enum(['poster-wall', 'shelf', 'list', 'grid', 'timeline']),
  sortBy: z.enum(['position', 'title', 'year', 'rating', 'added', 'track', 'episode']),
  sections: z
    .array(z.enum(['hero', 'summary', 'children', 'items', 'cast', 'fields', 'stats']))
    .max(10),
  showFields: z.array(z.string().max(100)).max(50).optional(),
  skin: z.string().max(120).optional(),
});

export const settingsPatchSchema = z.object({
  preferredSubtitleLanguage: z.string().max(10).optional(),
  preferredLyricsLanguage: z.string().max(10).optional(),
  autoFetchMetadata: z.boolean().optional(),
  groupedBrowseVideo: z.boolean().optional(),
  groupedBrowseAudio: z.boolean().optional(),
  activeSkin: z.string().max(120).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  server: z
    .object({
      enabled: z.boolean(),
      port: z.number().int().min(1024).max(65535),
      lanEnabled: z.boolean(),
    })
    .optional(),
});

/** §23. pinSet is derived from whether a PIN exists, so it is not accepted here. */
export const restrictionPatchSchema = z.object({
  enabled: z.boolean().optional(),
  maxAge: z.number().int().min(0).max(21).optional(),
  allowUnrated: z.boolean().optional(),
  blockExplicit: z.boolean().optional(),
  unlockMinutes: z.number().int().min(1).max(1440).optional(),
});

/** An absolute path supplied by the renderer. Never interpolated into a shell. */
const filePath = z.string().min(1).max(4096);

export const argSchemas = {
  'app:info': z.tuple([]),

  'sources:get': z.tuple([]),
  'sources:set': z.tuple([kind, filePath]),
  'sources:pickFolder': z.tuple([kind]),

  'library:list': z.tuple([filterSpecSchema, sortSpecSchema, z.string().max(200).nullable()]),
  'library:get': z.tuple([id]),
  'library:import': z.tuple([z.array(filePath).min(1).max(2000)]),
  'library:pickFiles': z.tuple([kind]),
  'library:setRating': z.tuple([id, z.number().min(0).max(10).nullable()]),
  'library:setFields': z.tuple([
    id,
    z.record(z.string().max(100), z.string().max(10000).nullable()),
  ]),

  'library:scan': z.tuple([kind.nullable(), z.boolean()]),
  'library:cancelScan': z.tuple([]),
  'library:setHidden': z.tuple([id, z.boolean()]),
  'library:setAgeRating': z.tuple([id, z.number().int().min(0).max(21).nullable()]),

  'media:streamUrl': z.tuple([id]),
  // Positions are clamped: a bad value should not poison resume.
  'player:progress': z.tuple([id, z.number().int().min(0).max(86_400_000)]),
  'player:finished': z.tuple([id]),
  'server:status': z.tuple([]),

  'restrictions:get': z.tuple([]),
  'restrictions:set': z.tuple([restrictionPatchSchema]),
  // A PIN is digits only, 4-12 of them; null clears it.
  'restrictions:setPin': z.tuple([z.string().regex(/^\d{4,12}$/).nullable()]),
  'restrictions:unlock': z.tuple([z.string().max(64)]),
  'restrictions:lock': z.tuple([]),

  'search:global': z.tuple([z.string().max(500), z.number().int().min(1).max(200)]),

  'groups:list': z.tuple([kind.nullable(), id.nullable()]),
  'groups:get': z.tuple([id]),
  'groups:setScreen': z.tuple([id, groupScreenSchema]),
  'groups:setFavorite': z.tuple([id, z.boolean()]),

  'settings:get': z.tuple([]),
  'settings:set': z.tuple([settingsPatchSchema]),
  'settings:setKey': z.tuple([z.enum(['tmdb', 'wyzie']), z.string().max(500).nullable()]),

  'providers:status': z.tuple([]),
} satisfies Record<IpcChannel, z.ZodType>;

export type ArgSchemas = typeof argSchemas;
