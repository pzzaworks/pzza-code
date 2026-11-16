// App commands for themes. A theme is colors only: PzzaCode, PzzaCode Light
// and a set of permissively licensed color schemes. configure_appearance
// switches to one by ID.

export const THEME_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });

export const THEME_APP_COMMANDS = {
  list_themes: command("List themes (id, name, dark or light) with the active theme ID. Narrow the list with query (matches names) or appearance; set one with configure_appearance's theme.", {
    query: { type: "string", minLength: 1, maxLength: 60, description: "Words the theme name contains, for example \"dracula\" or \"solarized light\"." },
    appearance: { type: "string", enum: ["dark", "light"] },
  }),
};
