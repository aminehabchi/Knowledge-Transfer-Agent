import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newId = () => randomUUID();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const iso = (d: Date) => d.toISOString();
export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

export function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}
