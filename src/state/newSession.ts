import { create } from "zustand";

// A request to open the new-session form with a folder already chosen, for
// example after a folder is dropped onto the canvas. The form consumes it once.
export interface NewSessionRequest {
  folder: string;
  host: string; // "" = this device
  nonce: number;
}

export const useNewSessionRequest = create<{ request: NewSessionRequest | null }>(() => ({ request: null }));

export function requestNewSession(folder: string, host = ""): void {
  if (!folder.startsWith("/") || folder.length > 4096 || /[\u0000-\u001f\u007f]/.test(folder)) return;
  useNewSessionRequest.setState({ request: { folder, host, nonce: Date.now() } });
}

export function consumeNewSessionRequest(): NewSessionRequest | null {
  const { request } = useNewSessionRequest.getState();
  if (request) useNewSessionRequest.setState({ request: null });
  return request;
}
