import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_NAMES, IPC_CHANNELS } from '@shared/ipc-contract';
import type { EventMap, EventName, QueApi } from '@shared/ipc-contract';

/**
 * The entire surface the renderer can reach. Nothing else crosses the bridge.
 *
 * Built by iterating IPC_CHANNELS so preload and main can never drift: a
 * channel added to the contract appears here automatically, and one removed
 * disappears.
 */

const api = Object.fromEntries(
  IPC_CHANNELS.map((channel) => [
    channel,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  ])
) as unknown as QueApi;

api.on = <E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): (() => void) => {
  if (!(EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error(`Unknown event "${event}"`);
  }
  const wrapped = (_e: unknown, payload: EventMap[E]): void => listener(payload);
  ipcRenderer.on(event, wrapped);
  return () => ipcRenderer.removeListener(event, wrapped);
};

/**
 * Drag-and-drop path resolution.
 *
 * File.path was removed from Electron; webUtils.getPathForFile replaces it and
 * is explicitly supported from a sandboxed preload. The renderer never sees a
 * filesystem path it did not obtain this way, and main re-validates every path
 * it is handed.
 */
const files = {
  pathFor(file: File): string {
    return webUtils.getPathForFile(file);
  },
  pathsFor(list: ArrayLike<File>): string[] {
    return Array.from(list)
      .map((f) => webUtils.getPathForFile(f))
      .filter((p) => p.length > 0);
  },
};

contextBridge.exposeInMainWorld('que', api);
contextBridge.exposeInMainWorld('queFiles', files);

export type QueFilesApi = typeof files;
