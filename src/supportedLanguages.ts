// The single list of languages PzzaCode supports for dictation. Codes match
// the speech engine's language tokens, in order of use among software
// developers (English and Turkish are mandatory). Flags are visual hints.
// src-tauri/src/speech.rs reads the codes from this file, so the two never
// differ.
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", native: "English", country: "US" },
  { code: "tr", label: "Turkish", native: "Türkçe", country: "TR" },
  { code: "es", label: "Spanish", native: "Español", country: "ES" },
  { code: "pt", label: "Portuguese", native: "Português", country: "PT" },
  { code: "ru", label: "Russian", native: "Русский", country: "RU" },
  { code: "de", label: "German", native: "Deutsch", country: "DE" },
  { code: "fr", label: "French", native: "Français", country: "FR" },
  { code: "pl", label: "Polish", native: "Polski", country: "PL" },
  { code: "uk", label: "Ukrainian", native: "Українська", country: "UA" },
  { code: "it", label: "Italian", native: "Italiano", country: "IT" },
  { code: "nl", label: "Dutch", native: "Nederlands", country: "NL" },
  { code: "sv", label: "Swedish", native: "Svenska", country: "SE" },
  { code: "cs", label: "Czech", native: "Čeština", country: "CZ" },
  { code: "ro", label: "Romanian", native: "Română", country: "RO" },
  { code: "el", label: "Greek", native: "Ελληνικά", country: "GR" },
  { code: "hu", label: "Hungarian", native: "Magyar", country: "HU" },
  { code: "da", label: "Danish", native: "Dansk", country: "DK" },
  { code: "fi", label: "Finnish", native: "Suomi", country: "FI" },
  { code: "no", label: "Norwegian", native: "Norsk", country: "NO" },
  { code: "sk", label: "Slovak", native: "Slovenčina", country: "SK" },
  { code: "bg", label: "Bulgarian", native: "Български", country: "BG" },
  { code: "lv", label: "Latvian", native: "Latviešu", country: "LV" },
  { code: "sl", label: "Slovenian", native: "Slovenščina", country: "SI" },
  { code: "hi", label: "Hindi", native: "हिन्दी", country: "IN" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.some((language) => language.code === value);
}
