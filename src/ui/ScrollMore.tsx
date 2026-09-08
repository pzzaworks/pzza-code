import { useEffect, useRef } from "react";

export function ScrollMore({ hasMore, loadMore }: { hasMore: boolean; loadMore(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); loadMore(); }
    }, { root: element.closest(".settings-hub-content"), rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);
  return hasMore ? <button ref={ref} className="scroll-more" onClick={loadMore}>Load more</button> : null;
}
