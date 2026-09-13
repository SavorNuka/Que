/**
 * The single source of truth for the IPC surface.
 * Main registers exactly these channels; preload exposes exactly these methods.
 *
 * Adding a channel means: add it here, add a Zod schema in schemas.ts,
 * add a handler in main/ipc/handlers.ts, add a binding in preload/index.ts.
 * The typecheck fails if any of the four is missing.
 */

import type {
  AppInfo,
  FilterSpec,
  GroupDetail,
  GroupScreen,
  GroupSummary,
  MediaDetail,
  MediaKind,
  MediaSummary,
  Page,
  ProviderStatus,
  RestrictionSettings,
  RestrictionState,
  ScanResult,
  ServerStatus,
  Settings,
  SortSpec,
  Source,
} from './types';

export interface IpcMap {
  'app:info': { args: []; result: AppInfo };

  'sources:get': { args: []; result: Source[] };
  'sources:set': { args: [kind: MediaKind, path: string]; result: Source };
  'sources:pickFolder': { args: [kind: MediaKind]; result: string | null };

  'library:list': {
    args: [filter: FilterSpec, sort: SortSpec, cursor: string | null];
    result: Page<MediaSummary>;
  };
  'library:get': { args: [id: number]; result: MediaDetail };
  'library:import': { args: [paths: string[]]; result: { imported: number; skipped: number } };
  'library:pickFiles': { args: [kind: MediaKind]; result: string[] };
  'library:setRating': { args: [id: number, rating: number | null]; result: void };
  'library:setFields': {
    args: [id: number, patch: Record<string, string | null>];
    result: MediaDetail;
  };
  'library:scan': { args: [kind: MediaKind | null, full: boolean]; result: ScanResult[] };
  'library:cancelScan': { args: []; result: void };
  'library:setHidden': { args: [id: number, hidden: boolean]; result: void };
  'library:setAgeRating': { args: [id: number, ageMin: number | null]; result: void };

  'media:streamUrl': { args: [id: number]; result: string };
  'player:progress': { args: [id: number, positionMs: number]; result: void };
  'player:finished': { args: [id: number]; result: void };
  'server:status': { args: []; result: ServerStatus };

  'restrictions:get': { args: []; result: RestrictionState };
  'restrictions:set': { args: [patch: Partial<RestrictionSettings>]; result: RestrictionState };
  'restrictions:setPin': { args: [pin: string | null]; result: RestrictionState };
  'restrictions:unlock': { args: [pin: string]; result: RestrictionState };
  'restrictions:lock': { args: []; result: RestrictionState };

  'search:global': { args: [q: string, limit: number]; result: MediaSummary[] };

  'groups:list': {
    args: [kind: MediaKind | null, parentId: number | null];
    result: GroupSummary[];
  };
  'groups:get': { args: [id: number]; result: GroupDetail };
  'groups:setScreen': { args: [id: number, screen: GroupScreen]; result: GroupDetail };
  'groups:setFavorite': { args: [id: number, favorite: boolean]; result: GroupSummary };

  'settings:get': { args: []; result: Settings };
  'settings:set': { args: [patch: Partial<Settings>]; result: Settings };
  'settings:setKey': { args: [which: 'tmdb' | 'wyzie', value: string | null]; result: Settings };

  'providers:status': { args: []; result: ProviderStatus[] };
}

export type IpcChannel = keyof IpcMap;

/** Runtime list — preload iterates this, so it must stay in sync with IpcMap. */
export const IPC_CHANNELS = [
  'app:info',
  'sources:get',
  'sources:set',
  'sources:pickFolder',
  'library:list',
  'library:get',
  'library:import',
  'library:pickFiles',
  'library:setRating',
  'library:setFields',
  'library:scan',
  'library:cancelScan',
  'library:setHidden',
  'library:setAgeRating',
  'media:streamUrl',
  'player:progress',
  'player:finished',
  'server:status',
  'restrictions:get',
  'restrictions:set',
  'restrictions:setPin',
  'restrictions:unlock',
  'restrictions:lock',
  'search:global',
  'groups:list',
  'groups:get',
  'groups:setScreen',
  'groups:setFavorite',
  'settings:get',
  'settings:set',
  'settings:setKey',
  'providers:status',
] as const satisfies readonly IpcChannel[];

/** Compile-time proof that IPC_CHANNELS covers every key of IpcMap. */
type Missing = Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>;
export type _AssertNoMissingChannels = Missing extends never ? true : ['missing channels', Missing];

/** Events pushed main -> renderer. */
export interface EventMap {
  'scan:progress': {
    kind: MediaKind;
    scanned: number;
    added: number;
    updated: number;
    moved: number;
    current: string | null;
    done: boolean;
  };
  'library:changed': { reason: 'import' | 'scan' | 'edit' | 'remove' };
  'provider:rateLimited': { provider: string; retryAfterMs: number };
}

export type EventName = keyof EventMap;

export const EVENT_NAMES = [
  'scan:progress',
  'library:changed',
  'provider:rateLimited',
] as const satisfies readonly EventName[];

export type QueApi = {
  [K in IpcChannel]: (...args: IpcMap[K]['args']) => Promise<IpcMap[K]['result']>;
} & {
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void;
};
