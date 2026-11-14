/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AlertDeliveryRecord,
  OrbitalEventRecord,
  StoredDecisionBrief,
} from '../shared/types.ts';
import { logInfo, logWarn } from './logger.ts';

export const ALERT_DEDUP_WINDOW_MS = 6 * 3600_000; // 6-hour deduplication & rate-limit window per (subscription, event, threatLevel)

export function classifyAlertChannel(channel: string): AlertDeliveryRecord['channelType'] {
  const lower = channel.trim().toLowerCase();
  if (lower.includes('hooks.slack.com')) return 'slack';
  if (lower.includes('discord.com/api/webhooks') || lower.includes('discordapp.com/api/webhooks')) {
    return 'discord';
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'webhook';
  return 'email';
}

export function buildAlertDedupKey(
  subscriptionId: string,
  eventId: string,
  threatLevel: 'LOW' | 'MEDIUM' | 'HIGH',
): string {
  return `${subscriptionId}:${eventId}:${threatLevel}`;
}

export function buildShareableEventUrl(eventId: string, baseUrl?: string): string {
  const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000')
    .trim()
    .replace(/\/+$/, '');
  return `${cleanBase}/?event=${encodeURIComponent(eventId)}`;
}

export function formatAlertPayloadForChannel(params: {
  channelType: AlertDeliveryRecord['channelType'];
  fleetLabel: string;
  event: OrbitalEventRecord;
  brief: StoredDecisionBrief | null;
  eventUrl: string;
}): Record<string, unknown> {
  const { channelType, fleetLabel, event, brief, eventUrl } = params;
  const sources = (brief?.evidence ?? [])
    .map((e) => e.source_url)
    .filter((u): u is string => Boolean(u))
    .slice(0, 4);

  const summary =
    brief?.summary ||
    `${event.suspectName} (#${event.suspectNoradId}) vs ${event.protectedName} (#${event.protectedNoradId}): min ${event.minDistanceKm.toFixed(2)} km, Δθ ${event.planeAngleDeg.toFixed(3)}°.`;

  if (channelType === 'slack') {
    return {
      text: `[SPECOLA ${event.threatLevel}] ${event.title} (${event.minDistanceKm.toFixed(2)} km)`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `SPECOLA ${event.threatLevel}: ${event.suspectName} ↔ ${event.protectedName}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Fleet:* ${fleetLabel}\n*Min Range:* ${event.minDistanceKm.toFixed(2)} km · *Plane Δθ:* ${event.planeAngleDeg.toFixed(3)}°\n*Summary:* ${summary}\n*Event Page:* <${eventUrl}|Inspect 3D Event Dossier>`,
          },
        },
        ...(sources.length > 0
          ? [
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Sources: ${sources.map((s) => `<${s}|${s}>`).join(' · ')}`,
                  },
                ],
              },
            ]
          : []),
      ],
    };
  }

  if (channelType === 'discord') {
    return {
      content: `**[SPECOLA ${event.threatLevel}]** ${event.title}`,
      embeds: [
        {
          title: `${event.suspectName} ↔ ${event.protectedName} (${event.minDistanceKm.toFixed(2)} km)`,
          url: eventUrl,
          description: summary,
          fields: [
            { name: 'Fleet', value: fleetLabel, inline: true },
            { name: 'Threat / Status', value: `${event.threatLevel} / ${event.status}`, inline: true },
            { name: 'Plane Δθ', value: `${event.planeAngleDeg.toFixed(3)}°`, inline: true },
            {
              name: 'Sources',
              value: sources.length > 0 ? sources.join('\n') : '18th SDS Space-Track GP + SGP4',
            },
          ],
          footer: { text: 'Specola Screening-Grade Analysis — Not a Collision Warning Service' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  return {
    source: 'specola-orbital-intelligence',
    fleetLabel,
    threatLevel: event.threatLevel,
    status: event.status,
    eventId: event.id,
    pairKey: event.pairKey,
    minDistanceKm: event.minDistanceKm,
    planeAngleDeg: event.planeAngleDeg,
    summary,
    sources,
    eventUrl,
    disclaimer: 'Screening-grade analysis — not a collision warning service.',
    sentAtUtc: new Date().toISOString(),
  };
}

export async function postWithRetryBackoff(
  url: string,
  payload: Record<string, unknown>,
  maxRetries = 2,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let lastError = 'Unknown delivery error';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Specola-Alert-Dispatcher/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        return { ok: true, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, status: 0, error: lastError };
}

export interface AlertStoreAdapter {
  hasRecentAlert(dedupKey: string, windowMs?: number): boolean;
  recordAlertDelivery(record: AlertDeliveryRecord): Promise<void>;
}

export async function dispatchEventAlert(params: {
  store: AlertStoreAdapter;
  subscriptionId: string;
  fleetLabel: string;
  notifyChannel: string;
  event: OrbitalEventRecord;
  brief: StoredDecisionBrief | null;
  appBaseUrl?: string;
  dedupWindowMs?: number;
}): Promise<AlertDeliveryRecord> {
  const { store, subscriptionId, fleetLabel, notifyChannel, event, brief, appBaseUrl, dedupWindowMs } =
    params;

  const channelType = classifyAlertChannel(notifyChannel);
  const dedupKey = buildAlertDedupKey(subscriptionId, event.id, event.threatLevel);
  const eventUrl = buildShareableEventUrl(event.id, appBaseUrl);
  const summary =
    brief?.summary ||
    `${event.suspectName} ↔ ${event.protectedName}: ${event.minDistanceKm.toFixed(2)} km (Δθ ${event.planeAngleDeg.toFixed(3)}°)`;

  const alreadySent = store.hasRecentAlert(dedupKey, dedupWindowMs ?? ALERT_DEDUP_WINDOW_MS);
  if (alreadySent) {
    const dedupRecord: AlertDeliveryRecord = {
      id: `alrt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      dedupKey,
      subscriptionId,
      eventId: event.id,
      pairKey: event.pairKey,
      threatLevel: event.threatLevel,
      channel: notifyChannel,
      channelType,
      deliveryStatus: 'deduplicated',
      sentAtUtc: new Date().toISOString(),
      summary,
      eventUrl,
    };
    await store.recordAlertDelivery(dedupRecord);
    logInfo('alert_deduplicated', { dedupKey, eventId: event.id, channelType });
    return dedupRecord;
  }

  let deliveryStatus: AlertDeliveryRecord['deliveryStatus'] = 'logged-no-smtp';
  if (channelType === 'email') {
    const smtpRelay = process.env.SMTP_WEBHOOK_URL?.trim();
    if (smtpRelay) {
      const payload = formatAlertPayloadForChannel({
        channelType: 'webhook',
        fleetLabel,
        event,
        brief,
        eventUrl,
      });
      const res = await postWithRetryBackoff(smtpRelay, { ...payload, recipientEmail: notifyChannel });
      deliveryStatus = res.ok ? 'delivered' : 'failed';
    } else {
      deliveryStatus = 'logged-no-smtp';
    }
  } else {
    const payload = formatAlertPayloadForChannel({
      channelType,
      fleetLabel,
      event,
      brief,
      eventUrl,
    });
    const res = await postWithRetryBackoff(notifyChannel, payload);
    deliveryStatus = res.ok ? 'delivered' : 'failed';
    if (!res.ok) {
      logWarn('alert_webhook_failed', { eventId: event.id, channelType, error: res.error });
    } else {
      logInfo('alert_webhook_delivered', { eventId: event.id, channelType });
    }
  }

  const record: AlertDeliveryRecord = {
    id: `alrt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dedupKey,
    subscriptionId,
    eventId: event.id,
    pairKey: event.pairKey,
    threatLevel: event.threatLevel,
    channel: notifyChannel,
    channelType,
    deliveryStatus,
    sentAtUtc: new Date().toISOString(),
    summary,
    eventUrl,
  };
  await store.recordAlertDelivery(record);
  return record;
}
