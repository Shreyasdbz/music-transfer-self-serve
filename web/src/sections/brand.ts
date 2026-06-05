// Provider brand assets (logo data, not theme tokens). Single source of truth:
// the repo-root `assets/` dir. Vite bundles + hashes them (import → URL string);
// `server.fs.allow` in vite.config permits reading from the repo root in dev.
import spotifyIcon from "../../../assets/Spotify_icon.png";
import appleIcon from "../../../assets/Apple_Music_icon.png";
import youtubeIcon from "../../../assets/Youtube_Music_icon.png";

const BRAND: Record<string, string> = {
  spotify: "#1DB954",
  apple: "#FA243C",
  youtube: "#FF0000",
};

const LOGO: Record<string, string> = {
  spotify: spotifyIcon,
  apple: appleIcon,
  youtube: youtubeIcon,
};

/** Fallback brand color for a provider's icon chip (used when no logo). */
export function brandColor(id: string): string {
  return BRAND[id] ?? "#8A8A8A";
}

/** The provider's logo image URL, or undefined if none is bundled. */
export function brandLogo(id: string): string | undefined {
  return LOGO[id];
}
