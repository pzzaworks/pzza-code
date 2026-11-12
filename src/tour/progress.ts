// Whether first-launch setup and the UI tour are still to come. Kept apart
// from the screens themselves so the app shell can decide what the first
// window shows before their code loads.

// Setup (SetupScreen). Installs that finished the earlier setup wizard or
// onboarding count as set up.
const SETUP_DONE_KEY = "pzza.setup.done";
const SETUP_LEGACY_DONE_KEYS = ["pzza.setupDone", "pzza.onboarding.done"];

// The UI tour (OnboardingTour). Installs that completed the earlier setup
// wizard or tour count as done.
const TOUR_DONE_KEY = "pzza.onboarding.done";
const TOUR_LEGACY_DONE_KEYS = ["pzza.setupDone", "pzza.tour.seen"];

function pending(key: string, legacy: readonly string[]): boolean {
  if (localStorage.getItem(key)) return false;
  if (legacy.some(entry => localStorage.getItem(entry))) {
    localStorage.setItem(key, "1");
    return false;
  }
  return true;
}

function markDone(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* private mode - nothing to remember */
  }
}

export function setupPending(): boolean {
  try {
    return pending(SETUP_DONE_KEY, SETUP_LEGACY_DONE_KEYS);
  } catch {
    // Storage is unavailable: never block every launch with setup.
    return false;
  }
}

export function onboardingPending(): boolean {
  try {
    return pending(TOUR_DONE_KEY, TOUR_LEGACY_DONE_KEYS);
  } catch {
    // Storage is unavailable: never trap the user in a tour on every launch.
    return false;
  }
}

export const markSetupDone = () => markDone(SETUP_DONE_KEY);
export const markOnboardingDone = () => markDone(TOUR_DONE_KEY);
