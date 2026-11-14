/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export function logInfo(event: string, data?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event,
      ...(data ?? {}),
    }),
  );
}

export function logWarn(event: string, data?: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      event,
      ...(data ?? {}),
    }),
  );
}

export function logError(event: string, error: unknown, data?: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event,
      message: error instanceof Error ? error.message : String(error),
      ...(data ?? {}),
    }),
  );
}
