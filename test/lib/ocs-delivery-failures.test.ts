import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deliveryFailureEvents,
  failuresSince,
  parseDeliveryFailures,
  parseNotificationList,
} from '../../lib/ocs-delivery-failures.js';

// Real pages read from OCS on 2026-11-02 (ace#3362): the team's notification list and one event's occurrences.
const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures/ocs', n), 'utf8');

describe('ocs delivery failures', () => {
  it('finds the "Message Delivery Failed" notification in the list, with its event page', () => {
    const events = deliveryFailureEvents(parseNotificationList(fx('notifications-table.html')));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventPath).toBe('/notifications/event/890/');
    expect(events[0].level).toBe('Error');
  });

  it('reads participant, platform, session and bot from each occurrence', () => {
    const f = parseDeliveryFailures(fx('notification-event-table.html'));
    expect(f.length).toBeGreaterThanOrEqual(3);
    const w1 = f.find((x) => x.participant === '1277adbd0ceea89e367d')!;
    expect(w1.platform).toBe('Commcare_Connect');
    expect(w1.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(w1.botPublicId).toBe('b681ae47-5e4d-4c7d-b0bb-f9e90664bdd1');
    expect(f.some((x) => x.participant === '9396ba0f84bf47b63d85')).toBe(true);
  });

  it('filters by time and participant', () => {
    const f = parseDeliveryFailures(fx('notification-event-table.html'));
    const newest = new Date(f.map((x) => x.timestamp).sort().at(-1)!);
    const justBefore = new Date(newest.getTime() - 1000);
    expect(failuresSince(f, justBefore, '1277adbd0ceea89e367d').length).toBeGreaterThan(0);
    expect(failuresSince(f, justBefore, '9396ba0f84bf47b63d85')).toEqual([]);
    expect(failuresSince(f, new Date(newest.getTime() + 1000))).toEqual([]);
  });

  it('an empty or unrelated page yields nothing, never a false failure', () => {
    expect(parseDeliveryFailures('<html></html>')).toEqual([]);
    expect(deliveryFailureEvents(parseNotificationList('<tr><td>x</td></tr>'))).toEqual([]);
  });
});
