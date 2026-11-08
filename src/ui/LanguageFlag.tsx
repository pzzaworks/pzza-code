// The country flag shown next to a language in the dictation language
// pickers. Every supported language's country has a flag here; the type
// keeps that true when the language list changes.
import type { ComponentType, SVGAttributes } from "react";
import type { SUPPORTED_LANGUAGES } from "../supportedLanguages";
import BG from "country-flag-icons/react/3x2/BG";
import CZ from "country-flag-icons/react/3x2/CZ";
import DE from "country-flag-icons/react/3x2/DE";
import DK from "country-flag-icons/react/3x2/DK";
import ES from "country-flag-icons/react/3x2/ES";
import FI from "country-flag-icons/react/3x2/FI";
import FR from "country-flag-icons/react/3x2/FR";
import GR from "country-flag-icons/react/3x2/GR";
import HU from "country-flag-icons/react/3x2/HU";
import IN from "country-flag-icons/react/3x2/IN";
import IT from "country-flag-icons/react/3x2/IT";
import LV from "country-flag-icons/react/3x2/LV";
import NL from "country-flag-icons/react/3x2/NL";
import NO from "country-flag-icons/react/3x2/NO";
import PL from "country-flag-icons/react/3x2/PL";
import PT from "country-flag-icons/react/3x2/PT";
import RO from "country-flag-icons/react/3x2/RO";
import RU from "country-flag-icons/react/3x2/RU";
import SE from "country-flag-icons/react/3x2/SE";
import SI from "country-flag-icons/react/3x2/SI";
import SK from "country-flag-icons/react/3x2/SK";
import TR from "country-flag-icons/react/3x2/TR";
import UA from "country-flag-icons/react/3x2/UA";
import US from "country-flag-icons/react/3x2/US";

type Country = (typeof SUPPORTED_LANGUAGES)[number]["country"];

const FLAGS: Record<Country, ComponentType<SVGAttributes<SVGElement>>> = { BG, CZ, DE, DK, ES, FI, FR, GR, HU, IN, IT, LV, NL, NO, PL, PT, RO, RU, SE, SI, SK, TR, UA, US };

export function LanguageFlag({ country }: { country: Country }) {
  const Flag = FLAGS[country];
  // Icon-sized flag: its 2px corner is a hairline mark, not a scale radius.
  return <Flag aria-hidden="true" style={{ width: 21, height: 14, borderRadius: 2, flexShrink: 0 }} />;
}
