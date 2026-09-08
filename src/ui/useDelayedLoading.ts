import { useEffect, useState } from "react";

// Pending actions disable immediately, but fast responses never flash a spinner.
export function useDelayedLoading(loading: boolean, delayMs = 250): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!loading) return;
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [loading, delayMs]);
  return loading && visible;
}
