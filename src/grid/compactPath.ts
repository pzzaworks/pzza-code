// A folder path short enough for a tile footer: the home folder becomes "~"
// and everything between the root and the last two folders becomes "…", so
// "/Users/me/Projects/Personal/app/web" reads "~/…/app/web".
export function compactPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(path);
  const root = home ? "~" : "";
  const rest = (home ? path.slice(home[0].length) : path).split("/").filter(Boolean);
  if (rest.length <= 2) return home ? [root, ...rest].join("/") : `/${rest.join("/")}`;
  return `${root}/…/${rest.slice(-2).join("/")}`;
}
