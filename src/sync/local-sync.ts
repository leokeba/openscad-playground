// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

// Local-files sync: load a project from a local sync server (see sync-server.mjs)
// and save the edited file back to it. Enable by adding ?sync=<serverUrl> to the
// page URL (e.g. ?sync=http://127.0.0.1:8787). Optional ?file=<path> selects the
// active file (default: an assembly.scad, else the first file).

import type { State } from '../state/app-state.ts';

export interface SyncFile {
  path: string; // relative to the repo root, /-separated
  content: string;
}

/** The sync server URL from the ?sync= query parameter, or null. */
export function getSyncUrl(): string | null {
  const url = new URL(window.location.href).searchParams.get('sync');
  return url ? url.replace(/\/+$/, '') : null;
}

/** The ?file= query parameter (relative path), or null. */
export function getSyncFileParam(): string | null {
  return new URL(window.location.href).searchParams.get('file');
}

function pickDefaultActivePath(files: SyncFile[]): string {
  // Prefer the machine's top-level model; else the first file.
  const asm = files.find(f => f.path === 'assembly.scad' || f.path.endsWith('/assembly.scad'));
  return asm?.path ?? files[0].path;
}

/** Fetch the project from the sync server. */
export async function loadSyncProject(serverUrl: string, fileParam?: string | null): Promise<{files: SyncFile[]; activePath: string}> {
  const res = await fetch(`${serverUrl}/api/files`);
  if (!res.ok) throw new Error(`Sync server returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const files: SyncFile[] = data?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Sync server returned no .scad files');
  }
  const activePath = fileParam ?? pickDefaultActivePath(files);
  if (!files.find(f => f.path === activePath)) {
    throw new Error(`File "${activePath}" not found in the sync server (available: ${files.map(f => f.path).join(', ')})`);
  }
  return {files, activePath};
}

/** Write the project files to the main-thread FS so the file picker lists them. */
export function writeSourcesToFS(fs: FS, files: SyncFile[]): void {
  for (const f of files) {
    const abs = '/' + f.path;
    let dir = '';
    for (const part of abs.split('/').slice(0, -1)) {
      if (part === '') continue;
      dir += '/' + part;
      try { (fs as any).mkdir(dir); } catch (e) { /* already exists */ }
    }
    fs.writeFile(abs, f.content);
  }
}

/**
 * Debounced save of the active file to the sync server. One instance per
 * session; created by the caller with the loaded project, then fed on every
 * state change.
 */
export class SyncClient {
  private timer: number | undefined;
  private lastSaved = new Map<string, string>();
  private retryTimer: number | undefined;
  private pending: {path: string; content: string} | undefined;

  constructor(private serverUrl: string) {}

  /** Seed the "already saved" state (e.g. with the loaded project) so the initial render doesn't trigger a save. */
  markSaved(path: string, content: string): void {
    this.lastSaved.set(path, content);
  }

  /** Schedule a save of the active file (debounced). Cheap to call on every state change. */
  scheduleSave(state: State): void {
    const params = state.params;
    const active = params.sources.find(s => s.path === params.activePath);
    if (!active || active.content == null) return;
    const rel = active.path.startsWith('/') ? active.path.slice(1) : active.path;
    if (this.lastSaved.get(rel) === active.content) return;
    this.pending = {path: rel, content: active.content};
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), 500);
  }

  private async flush(): Promise<void> {
    if (this.timer != null) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.retryTimer != null) { window.clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const {path, content} = pending;
    const url = `${this.serverUrl}/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {'content-type': 'text/plain; charset=utf-8'},
        body: content,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      this.lastSaved.set(path, content);
    } catch (e) {
      console.error('[sync] save failed:', e);
      // Keep the content pending and retry in a few seconds.
      this.pending = pending;
      this.retryTimer = window.setTimeout(() => this.flush(), 3000);
    }
  }
}
