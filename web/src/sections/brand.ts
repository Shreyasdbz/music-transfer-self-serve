// Provider brand colors (logo data, not theme tokens).
const BRAND: Record<string, string> = {
  spotify: "#1DB954",
  apple: "#FA243C",
  youtube: "#FF0000",
};

export function brandColor(id: string): string {
  return BRAND[id] ?? "#8A8A8A";
}
