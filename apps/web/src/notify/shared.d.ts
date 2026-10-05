import type { DeviceState } from '@penge/contracts';

export interface PushState {
  credential: string | null;
  confirmed: boolean;
  askedAt: number | null;
  revision: number;
  fingerprint: string | null;
  applicationServerKey: string | null;
}
export interface PushEnv {
  indexedDB: IDBFactory;
  locks: Pick<LockManager, 'request'>;
  crypto: Crypto;
}
export interface BrowserSubscription {
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  /** The server key it was made with, where the browser says. */
  options?: { applicationServerKey?: ArrayBuffer | null };
  unsubscribe(): Promise<boolean>;
}
export interface Registration {
  pushManager: {
    getSubscription(): Promise<BrowserSubscription | null>;
    subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<BrowserSubscription>;
  };
}
/** Sends JSON to the API and resolves with its JSON answer (plain JavaScript on both sides of it). */
export type Post = (path: string, body: any, method?: 'POST' | 'DELETE') => Promise<any>;

export const LOCK_NAME: string;
export function readState(env: PushEnv): Promise<PushState>;
export function writeState(env: PushEnv, patch: Partial<PushState>): Promise<void>;
export function withPushLock<T>(env: PushEnv, fn: () => Promise<T>): Promise<T>;
export function fingerprint(env: PushEnv, json: { endpoint?: string; keys?: Record<string, string> }): Promise<string>;
export function newCredential(env: PushEnv): string;
export function credentialHash(env: PushEnv, credential: string): Promise<string>;
export function keyBytes(b64url: string): Uint8Array;
export function ensureSubscribed(env: PushEnv, a: { registration: Registration; applicationServerKey: string }): Promise<{ credentialHash: string }>;
export function reconcile(env: PushEnv, a: { registration: Registration; post: Post; permission: NotificationPermission }): Promise<{ state: DeviceState; subscribed: boolean } | null>;
export function turnOff(env: PushEnv, a: { registration: Registration; post: Post }): Promise<{ ok: true; noChannel: boolean } | null>;
export function markRequested(env: PushEnv): Promise<void>;
