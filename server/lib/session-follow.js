// A renamed tmux session keeps the names it had before in a user option, so a
// tile that still knows it by an old name (in another app window, on another
// Mac, or one that was closed during the rename) follows it on its next
// attach instead of creating an empty session under the old name. Pure: the
// app's attach commands (src/connection.ts) build on it too.

export const PREVIOUS_NAMES_OPTION = "@pzza-previous-names";
// Session names never contain control characters, so this separates them.
export const PREVIOUS_NAMES_SEPARATOR = "\x1e";
// The most recent names kept per session.
export const PREVIOUS_NAMES_KEPT = 16;
// Printed by an attach that followed a rename. Only a hint to look the new
// name up on the device: terminal output can print it too, so it is never
// trusted on its own.
export const RENAMED_OSC = 7337;

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Shell that sets $pzza_follow to the id of the session that was renamed away
 * from `name`, when no session has that name now; empty otherwise. When it
 * finds one it prints the RENAMED_OSC hint. `tmux` is the tmux invocation.
 */
export function followRenamedScript(tmux, name) {
  if (typeof name !== "string" || !name || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid session");
  const lookup = `{ n = split($2, names, "\\036"); for (i = 1; i <= n; i++) if (names[i] == ENVIRON["PZZA_PREVIOUS"]) { print $1; exit } }`;
  return `pzza_follow=; if ! ${tmux} has-session -t ${quote("=" + name)} 2>/dev/null; then ` +
    `pzza_follow=$(${tmux} -u list-sessions -F '#{session_id}\t#{${PREVIOUS_NAMES_OPTION}}' 2>/dev/null | ` +
    `PZZA_PREVIOUS=${quote(name)} awk -F '\t' ${quote(lookup)}); fi; ` +
    `[ -z "$pzza_follow" ] || printf '\\033]${RENAMED_OSC};renamed\\007'; `;
}

/**
 * Shell run right after `tmux rename-session` (session id in $session_id):
 * records `oldName` as one of the session's previous names, and takes both
 * names out of every other session's list, so each name leads to at most one
 * session: the one last renamed away from it.
 */
export function rememberPreviousNameScript(tmux, oldName, newName) {
  const lines = (names) => `printf '%s' "${names}" | tr '\\036' '\\n' | grep -Fvx -e ${quote(oldName)} -e ${quote(newName)} | tail -n ${PREVIOUS_NAMES_KEPT - 1}`;
  return `${tmux} -u list-sessions -F '#{session_id}\t#{${PREVIOUS_NAMES_OPTION}}' 2>/dev/null | while IFS="$(printf '\\t')" read -r id names; do
  [ -n "$names" ] || [ "$id" = "$session_id" ] || continue
  kept=$(${lines("$names")})
  [ "$id" != "$session_id" ] || kept=$(printf '%s\\n%s' "$kept" ${quote(oldName)} | sed '/^$/d')
  joined=$(printf '%s' "$kept" | tr '\\n' '\\036')
  if [ -n "$joined" ]; then ${tmux} set-option -t "$id" ${PREVIOUS_NAMES_OPTION} "$joined"; else ${tmux} set-option -u -t "$id" ${PREVIOUS_NAMES_OPTION} 2>/dev/null; fi
done`;
}

/** Parses `list-sessions -F '#{session_name}\t#{@pzza-previous-names}'`. */
export function parsePreviousNames(output) {
  const sessions = [];
  for (const line of String(output || "").split("\n")) {
    if (!line) continue;
    // A previous name never holds a tab; a session made outside the app might.
    const tab = line.lastIndexOf("\t");
    if (tab <= 0) continue;
    const previous = line.slice(tab + 1).split(PREVIOUS_NAMES_SEPARATOR).filter(Boolean);
    sessions.push({ name: line.slice(0, tab), previous });
  }
  return sessions;
}

/**
 * The live session a tile known by `name` belongs to now: `name` itself while
 * a session has it, else the one renamed away from it; null when neither.
 */
export function currentSessionName(sessions, name) {
  if (sessions.some((session) => session.name === name)) return name;
  return sessions.find((session) => session.previous.includes(name))?.name ?? null;
}
