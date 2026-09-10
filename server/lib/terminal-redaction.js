export function redactTerminalOutput(text) {
  let redacted = false;
  let privateKey = false;
  const mask = () => { redacted = true; return "[REDACTED]"; };
  const lines = text.split("\n").map(line => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = true;
    if (privateKey) { if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = false; return mask(); }
    if (/\b(?:[A-Za-z0-9_]*(?:token|password|passwd|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*\S/i.test(line) || /\b(?:authorization|proxy-authorization)\s*:\s*\S/i.test(line)) return mask();
    return line.replace(/\b(?:https?:\/\/)[^\s/@]+@/gi, match => match.slice(0, match.indexOf("://") + 3) + mask() + "@")
      .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]*@/g, (_, scheme) => scheme + mask() + "@")
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, mask)
      .replace(/(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, mask)
      .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, value => {
        const counts = new Map();
        for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
        const entropy = [...counts.values()].reduce((total, count) => { const p = count / value.length; return total - p * Math.log2(p); }, 0);
        return entropy > 3.5 ? mask() : value;
      });
  });
  return { text: lines.join("\n"), redacted };
}
