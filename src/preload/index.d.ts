import type { QueApi } from '@shared/ipc-contract';

declare global {
  interface Window {
    que: QueApi;
    queFiles: {
      pathFor(file: File): string;
      pathsFor(list: FileList | File[]): string[];
    };
  }
}

export {};
