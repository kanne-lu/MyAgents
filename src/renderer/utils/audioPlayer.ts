/**
 * Global singleton audio player.
 *
 * Ensures only one audio plays at a time across the entire app.
 * Provides play/stop control and state callbacks for UI updates.
 */
import { isTauriEnvironment } from '@/utils/browserMock';

/** Convert a local file path to a playable audio URL */
export function getAudioUrl(filePath: string): string {
  if (isTauriEnvironment()) {
    const encoded = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `asset://localhost/${encoded}`;
  }
  return `/api/audio?path=${encodeURIComponent(filePath)}`;
}

/** Audio extensions we recognize for inline playback */
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'opus', 'webm', 'aac', 'm4a']);

/** Check if a file path is an audio file */
export function isAudioPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? AUDIO_EXTENSIONS.has(ext) : false;
}

type StateListener = (state: { playing: boolean; currentPath: string | null; progress: number; duration: number }) => void;

let audio: HTMLAudioElement | null = null;
let currentPath: string | null = null;
const listeners = new Set<StateListener>();

function notify() {
  const state = {
    playing: audio ? !audio.paused && !audio.ended : false,
    currentPath,
    progress: audio?.currentTime ?? 0,
    duration: audio?.duration ?? 0,
  };
  for (const fn of listeners) fn(state);
}

/** Subscribe to audio state changes. Returns unsubscribe function. */
export function subscribeAudio(fn: StateListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Play an audio file. Stops any currently playing audio first. */
export function playAudio(filePath: string): void {
  stopAudio();
  currentPath = filePath;
  audio = new Audio(getAudioUrl(filePath));
  audio.addEventListener('play', notify);
  audio.addEventListener('pause', notify);
  audio.addEventListener('ended', () => { currentPath = null; notify(); });
  audio.addEventListener('timeupdate', notify);
  audio.addEventListener('error', () => { currentPath = null; notify(); });
  audio.play().catch(() => { currentPath = null; notify(); });
}

/** Stop currently playing audio. */
export function stopAudio(): void {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // release resources
    audio = null;
  }
  currentPath = null;
  notify();
}

/** Check if a specific file is currently playing */
export function isPlaying(filePath: string): boolean {
  return currentPath === filePath && audio !== null && !audio.paused && !audio.ended;
}
