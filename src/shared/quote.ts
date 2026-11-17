// Entfernt zitierten Verlauf und Signaturen aus Antwort-Mails, damit nur die neue Antwort übrig bleibt.

const QUOTE_HEADER_PATTERNS: RegExp[] = [
  /^\s*(am|on)\s.+(schrieb|wrote|a écrit|escribió)\s*.*:?\s*$/i,
  /^\s*-{2,}\s*(original message|ursprüngliche nachricht|weitergeleitete nachricht|forwarded message)\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*(von|from)\s*:\s.+$/i,
  /^\s*(gesendet|sent)\s*:\s.+$/i,
];

export function stripQuotedText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*>/.test(line)) break;
    if (/^-- ?$/.test(line)) break; // Signatur-Trenner
    // "Am Mo., 3. März 2025 um 10:00 Uhr schrieb Max <max@firma.de>:" kann umbrechen
    const twoLines = `${line} ${lines[i + 1] ?? ""}`;
    if (QUOTE_HEADER_PATTERNS.some((p) => p.test(line)) || /^\s*(am|on)\s.+(schrieb|wrote)/i.test(twoLines)) {
      // Nur abschneiden, wenn schon Text davor steht oder es eindeutig ein Zitatkopf ist
      break;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function snippet(text: string, max = 600): string {
  const t = text.replace(/\s+\n/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()} …` : t;
}
