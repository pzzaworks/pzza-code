import { SUPPORTED_LANGUAGES, isSupportedLanguage, type SupportedLanguage } from "./supportedLanguages";

// Dictation recognizes exactly the supported speech languages, plus
// automatic detection among them.
export const DICTATION_LANGUAGES = SUPPORTED_LANGUAGES;

export type DictationLanguage = "auto" | SupportedLanguage;

export function isDictationLanguage(value: unknown): value is DictationLanguage {
  return value === "auto" || isSupportedLanguage(value);
}
