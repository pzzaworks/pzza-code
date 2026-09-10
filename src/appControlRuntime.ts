import { APP_COMMANDS, validateAppCommand } from "../server/lib/app-control-schema.js";

type Handler = (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();
const readers = new Map<string, () => unknown>();

export function registerAppControlHandler(action: string, handler: Handler): () => void {
  if (!Object.hasOwn(APP_COMMANDS, action)) throw new Error(`Unknown app action: ${action}`);
  if (handlers.has(action)) throw new Error(`App action already registered: ${action}`);
  handlers.set(action, handler);
  return () => { if (handlers.get(action) === handler) handlers.delete(action); };
}

export function registerAppControlState(scope: string, read: () => unknown): () => void {
  if (readers.has(scope)) throw new Error(`App state already registered: ${scope}`);
  readers.set(scope, read);
  return () => { if (readers.get(scope) === read) readers.delete(scope); };
}

export function readAppControlRuntime(): Record<string, unknown> {
  return Object.fromEntries([...readers].map(([scope, read]) => [scope, read()]));
}

export function executeAppControlRuntime(action: string, args: Record<string, unknown>): unknown | Promise<unknown> {
  const handler = handlers.get(action);
  if (!handler) throw new Error("The requested app capability is not available in this window.");
  return handler(validateAppCommand(action, args));
}

const menus = new Map<string, (open: boolean) => void>();
export function registerAppControlMenu(id: string, change: (open: boolean) => void): () => void {
  if (menus.has(id)) throw new Error(`App menu already registered: ${id}`);
  menus.set(id, change);
  return () => { if (menus.get(id) === change) menus.delete(id); };
}
export function setAppControlMenu(id: string, open: boolean): void {
  const change = menus.get(id);
  if (!change) throw new Error("This menu is not available in the selected app window.");
  change(open);
}

let executingCommand: string | undefined;
const afterReports = new Map<string, () => Promise<void>>();
export async function runAppControlExecution(id: string, run: () => unknown): Promise<unknown> {
  executingCommand = id;
  try { return await run(); }
  catch (error) { afterReports.delete(id); throw error; }
  finally { executingCommand = undefined; }
}
export function afterAppControlReport(run: () => Promise<void>): void {
  if (!executingCommand) throw new Error("This action requires an acknowledged app-control request.");
  afterReports.set(executingCommand, run);
}
export async function finishAppControlReport(id: string): Promise<void> {
  const run = afterReports.get(id);
  afterReports.delete(id);
  await run?.();
}
export function discardAppControlReport(id: string): void { afterReports.delete(id); }
