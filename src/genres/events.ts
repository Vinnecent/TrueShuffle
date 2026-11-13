/**
 * Tells interested screens (the tab bar shows the Genres tab only when there are genres) that the stored
 * genres changed: after a Spotify or MusicBrainz sync, Clear genres, Clear library or an import.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onGenresChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyGenresChanged(): void {
  for (const listener of listeners) listener();
}
