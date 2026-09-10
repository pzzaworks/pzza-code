export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}
export interface ConfirmationRequest extends ConfirmationOptions { id: number; resolve: (accepted: boolean) => void }
let nextId = 0;
let hosts = 0;
const queue: ConfirmationRequest[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeConfirmations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const currentConfirmation = () => queue[0] ?? null;

export function confirmAction(options: ConfirmationOptions): Promise<boolean> {
  return new Promise(resolve => { queue.push({ ...options, id: ++nextId, resolve }); notify(); });
}

export function answerConfirmation(request: ConfirmationRequest, accepted: boolean): void {
  if (queue[0] !== request) return;
  queue.shift();
  request.resolve(accepted);
  notify();
}

export function mountConfirmationHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    // Cancel every waiter on a real teardown, not on an effect remount.
    queueMicrotask(() => { if (!hosts) { queue.splice(0).forEach(item => item.resolve(false)); notify(); } });
  };
}
