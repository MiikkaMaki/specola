import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAlertDedupKey,
  buildShareableEventUrl,
  classifyAlertChannel,
  dispatchEventAlert,
  formatAlertPayloadForChannel,
} from './alerts.ts';
import { SpecolaStore } from './db.ts';
import type { OrbitalEventRecord, StoredDecisionBrief } from '../shared/types.ts';

function createFixtureEvent(threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH'): OrbitalEventRecord {
  return {
    id: 'evt-cosmos2612-iceyex36',
    pairKey: '68762-59103',
    suspectNoradId: 68762,
    protectedNoradId: 59103,
    suspectName: 'COSMOS 2612',
    protectedName: 'ICEYE-X36',
    suspectCountry: 'RU',
    protectedCountry: 'EU/FI',
    orbitRegime: 'LEO-SSO',
    title: 'COSMOS 2612 Coplanar Approach on ICEYE-X36',
    eventType: 'rpo_campaign',
    status: 'confirmed',
    threatLevel,
    eventTimeUtc: '2026-10-16T07:28:00Z',
    detectedAtUtc: '2026-10-12T06:00:00Z',
    minDistanceKm: 4.54,
    planeAngleDeg: 0.003,
    estimatedDeltaVMs: 1.85,
    briefId: 'brief-test-1',
    claimsCount: 3,
  };
}

function createFixtureBrief(): StoredDecisionBrief {
  return {
    id: 'brief-test-1',
    eventId: 'evt-cosmos2612-iceyex36',
    generatedAtUtc: '2026-11-14T08:00:00Z',
    modelUsed: 'gemini-4-carbon',
    latencyMs: 640,
    status: 'confirmed',
    threat_level: 'HIGH',
    title: 'COSMOS 2612 Coplanar Inspection of ICEYE-X36',
    summary: 'SGP4 propagation confirms a 4.54 km closest approach on 2026-10-16 at 07:28 UTC.',
    affected_operators: ['ICEYE (Finland / US)'],
    evidence: [
      {
        claim: 'Orbital Radar recorded 4.58 km TCA at 07:28 UTC.',
        source_url: 'https://orbitalradar.com/cosmos-2612-iceye-x36',
        source_date: '2026-10-16',
        data_origin: 'web_report',
        orbit_calc: 'SGP4 4.54 km at 07:28 UTC',
        verification_tag: 'verified',
      },
      {
        claim: 'Public TLE ~1 km epoch uncertainty (+1–3 km/day).',
        source_url: null,
        source_date: '2026-11-14',
        data_origin: 'sgp4_engine',
        orbit_calc: '1-sigma covariance ~1 km',
        verification_tag: 'verified',
      },
    ],
    recommended_actions: [
      'Schedule conjunction review using owner-operator OEM ephemeris.',
      'Notify national SSA watch desk.',
    ],
    who_to_notify: ['ICEYE Flight Dynamics', 'Traficom / National SSA'],
    uncertainty_statement: 'Screening-grade public GP/TLE analysis (~1 km at epoch, +1-3 km/day growth).',
  };
}

test('classifyAlertChannel identifies Slack, Discord, HTTPS webhook, and email targets', () => {
  assert.equal(classifyAlertChannel('https://hooks.slack.com/services/T00/B00/XYZ'), 'slack');
  assert.equal(classifyAlertChannel('https://discord.com/api/webhooks/123456/abcdef'), 'discord');
  assert.equal(classifyAlertChannel('https://ops.example.eu/webhooks/specola'), 'webhook');
  assert.equal(classifyAlertChannel('ssa-desk@iceye.fi'), 'email');
});

test('formatAlertPayloadForChannel includes brief summary, clickable sources, and shareable event URL', () => {
  const event = createFixtureEvent('HIGH');
  const brief = createFixtureBrief();
  const eventUrl = buildShareableEventUrl(event.id, 'https://specola.eu');

  assert.equal(eventUrl, 'https://specola.eu/?event=evt-cosmos2612-iceyex36');

  const slackPayload = formatAlertPayloadForChannel({
    channelType: 'slack',
    fleetLabel: 'ICEYE Nordic Fleet',
    event,
    brief,
    eventUrl,
  });
  assert.match(String(slackPayload.text), /SPECOLA HIGH/);
  assert.ok(Array.isArray(slackPayload.blocks) && slackPayload.blocks.length >= 2);

  const discordPayload = formatAlertPayloadForChannel({
    channelType: 'discord',
    fleetLabel: 'ICEYE Nordic Fleet',
    event,
    brief,
    eventUrl,
  });
  assert.ok(Array.isArray(discordPayload.embeds) && discordPayload.embeds.length === 1);

  const genericPayload = formatAlertPayloadForChannel({
    channelType: 'webhook',
    fleetLabel: 'ICEYE Nordic Fleet',
    event,
    brief,
    eventUrl,
  });
  assert.equal(genericPayload.eventUrl, eventUrl);
  assert.deepEqual(genericPayload.sources, ['https://orbitalradar.com/cosmos-2612-iceye-x36']);
});

test('Alert deduplication blocks repeat alerts within 6h unless threat level escalates, and API keys validate via SHA-256', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'specola-test-'));
  try {
    process.chdir(tempRoot);
    const store = new SpecolaStore();
    const highEvent = createFixtureEvent('HIGH');
    const medEvent = createFixtureEvent('MEDIUM');
    const brief = createFixtureBrief();

    // First email alert without SMTP relay logs honestly as 'logged-no-smtp'
    const first = await dispatchEventAlert({
      store,
      subscriptionId: 'sub-iceye-1',
      fleetLabel: 'ICEYE Finland',
      notifyChannel: 'flight-dynamics@iceye.fi',
      event: medEvent,
      brief,
      appBaseUrl: 'https://specola.eu',
    });
    assert.equal(first.deliveryStatus, 'logged-no-smtp');
    assert.equal(first.dedupKey, buildAlertDedupKey('sub-iceye-1', medEvent.id, 'MEDIUM'));

    // Repeating same (subscription, event, MEDIUM) within 6h deduplicates
    const duplicate = await dispatchEventAlert({
      store,
      subscriptionId: 'sub-iceye-1',
      fleetLabel: 'ICEYE Finland',
      notifyChannel: 'flight-dynamics@iceye.fi',
      event: medEvent,
      brief,
      appBaseUrl: 'https://specola.eu',
    });
    assert.equal(duplicate.deliveryStatus, 'deduplicated');

    // Threat escalation to HIGH produces a distinct dedup key and fires immediately
    const escalated = await dispatchEventAlert({
      store,
      subscriptionId: 'sub-iceye-1',
      fleetLabel: 'ICEYE Finland',
      notifyChannel: 'flight-dynamics@iceye.fi',
      event: highEvent,
      brief,
      appBaseUrl: 'https://specola.eu',
    });
    assert.equal(escalated.deliveryStatus, 'logged-no-smtp');
    assert.equal(escalated.threatLevel, 'HIGH');

    // API key generation + verification
    const { record, rawKey } = await store.createApiKey('Test Partner Desk');
    assert.ok(rawKey.startsWith('spc_live_'));
    assert.equal(record.label, 'Test Partner Desk');
    assert.equal(store.validateApiKey(rawKey), true);
    assert.equal(store.validateApiKey('spc_live_invalid_key_value'), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
