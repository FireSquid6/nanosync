import { test as base, expect, type Page } from '@playwright/test';
import { initialState, STORAGE_KEY, type MockState, type EnrollmentStatus } from '../src/mainview/mock';

export { expect };
export const test = base;

export async function openApp(page: Page, change?: (state: MockState) => void) {
  const state = initialState();
  change?.(state);
  await page.addInitScript(({ key, state }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(state));
  }, { key: STORAGE_KEY, state });
  await page.goto('/');
}

export async function savedState(page: Page): Promise<MockState> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
}

export function pendingEnrollment(outcome: EnrollmentStatus = 'pending') {
  return {
    id: 'test-pending-identity', code: 'TEST–18AB', server: 'https://sync.home.example',
    name: 'test-server', device: 'test-device', status: 'pending' as const, outcome,
    admin: true, step: 1, vault: 'documents', path: '/home/alex/Sync/test', consent: false,
  };
}
