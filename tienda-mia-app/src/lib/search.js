// Normalizes text for searching: strips invisible characters that sometimes
// ride along with copy-pasted or imported product names (non-breaking spaces,
// zero-width spaces), and treats common separator punctuation (commas,
// slashes, hyphens, underscores) the same as a space — so a search for
// "T MIA" still finds a product actually named "T,MIA ..." or "T/MIA ...".
export function normalizeSearchText(v) {
  return (v ?? '')
    .normalize('NFKC')
    // eslint-disable-next-line no-misleading-character-class -- intentional list of individual invisible chars, not a ZWJ sequence
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u00A0]/g, ' ')
    .replace(/[,/_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
