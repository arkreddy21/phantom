import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const username = process.env.AUTH_USERNAME || 'phantom-e2e';
const password = process.env.AUTH_PASSWORD || 'phantom-e2e-password';
const production = process.env.E2E_PRODUCTION === '1';

async function signIn(page: Page, user = username, pass = password) {
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function hasHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

test('private UI is gated until authenticated; invalid and valid sign-in work across reloads', async ({ page }) => {
  const privateRequests: number[] = [];
  page.on('request', request => { if (request.url().includes('/api/state')) privateRequests.push(Date.now()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(privateRequests).toHaveLength(0);

  await signIn(page, username, 'incorrect-password');
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(5);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
});

test('logout clears private UI and protected API access; expired cookies re-gate on next API request', async ({ page, context }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Your data, your call.' });
  const logoutResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
  await settings.getByRole('button', { name: 'Sign out' }).click();
  expect((await logoutResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
  const loggedOutResponse = await page.evaluate(async () => {
    const response = await fetch('/api/state');
    return response.status;
  });
  expect(loggedOutResponse).toBe(401);

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await context.clearCookies();
  await page.getByRole('button', { name: 'Settings' }).click();
  const exportButton = page.getByRole('dialog', { name: 'Your data, your call.' }).getByRole('button', { name: 'Export' });
  const expiredResponse = page.waitForResponse(response => response.url().endsWith('/api/backup') && response.status() === 401);
  await exportButton.click();
  await expiredResponse;
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Your session has ended. Sign in again to continue.');
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
});

test('login and settings install guidance fit mobile viewports and remain keyboard operable', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await mkdir('/tmp/opencode', { recursive: true });
  await page.screenshot({ path: '/tmp/opencode/phantom-auth-mobile.png', fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Phantom' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Username')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await hasHorizontalOverflow(page)).toBe(false);

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  const installHelp = page.getByRole('button', { name: 'Use Phantom like an app' });
  await expect(installHelp).toBeVisible();
  await installHelp.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Tap Share in Safari, then choose Add to Home Screen.')).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await context.close();
});

test('failed logout hides private data and locks sign-in until a retry revokes the session', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await page.route('**/api/auth/logout', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Could not confirm sign out');
  await expect(page.getByRole('button', { name: 'Retry sign out' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByLabel('Username')).toBeDisabled();
  await expect(page.getByLabel('Password')).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
  expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(200);

  await page.unroute('**/api/auth/logout');
  const retryLogout = page.waitForResponse(response => response.url().endsWith('/api/auth/logout') && response.status() === 200);
  await page.getByRole('button', { name: 'Retry sign out' }).click();
  await retryLogout;
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
});

test('a delayed logout cannot race a new sign-in and confirmed logout gates other tabs', async ({ context }) => {
  const firstPage = await context.newPage();
  await firstPage.goto('/');
  await signIn(firstPage);
  await expect(firstPage.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  const secondPage = await context.newPage();
  await secondPage.goto('/');
  await expect(secondPage.getByRole('heading', { name: 'Your practices.' })).toBeVisible();

  let releaseLogout!: () => void;
  const logoutHeld = new Promise<void>(resolve => { releaseLogout = resolve; });
  await firstPage.route('**/api/auth/logout', async route => {
    await logoutHeld;
    await route.continue();
  });
  await firstPage.getByRole('button', { name: 'Settings' }).click();
  const logoutResponse = firstPage.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
  await firstPage.getByRole('button', { name: 'Sign out' }).click();
  await expect(firstPage.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(firstPage.getByRole('button', { name: /Signing out/ })).toBeDisabled();
  await expect(firstPage.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  releaseLogout();
  expect((await logoutResponse).status()).toBe(200);
  await firstPage.unroute('**/api/auth/logout');
  await expect(firstPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(secondPage.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(secondPage.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
});

test('returning to a visible tab revalidates session without discarding an open journal draft', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await page.getByRole('button', { name: 'Complete Gratitude' }).click();
  const journal = page.getByRole('dialog', { name: 'A moment to reflect.' });
  await journal.getByLabel('Your reflection').fill('Draft survives returning to the tab.');
  const sessionCheck = page.waitForResponse(response => response.url().endsWith('/api/auth/session'));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  expect((await sessionCheck).status()).toBe(200);
  await expect(journal.getByLabel('Your reflection')).toHaveValue('Draft survives returning to the tab.');
  await expect(journal).toBeVisible();
});

test('offline transition hides private UI and online session validation restores it', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('You’re offline.');
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);

  const sessionCheck = page.waitForResponse(response => response.url().endsWith('/api/auth/session'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await sessionCheck).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await expect.poll(() => page.locator('.habit-card').count()).toBeGreaterThan(0);
});

test('production PWA assets and worker are valid and never cache private data or persist tokens', async ({ page, context }) => {
  test.skip(!production, 'requires E2E_PRODUCTION=1 and the built production server');
  await page.goto('/');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.ok(), icon.src).toBeTruthy();
    const bytes = await response.body();
    expect(bytes.toString('ascii', 1, 4)).toBe('PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    expect(icon.sizes).toBe(`${width}x${height}`);
    if (icon.purpose === 'maskable') expect(width).toBeGreaterThanOrEqual(512);
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /token|session|auth/i.test(key)))).toEqual([]);
  await page.getByRole('button', { name: 'Settings' }).click();
  const logoutResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await logoutResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();

  const persistence = await page.evaluate(async () => {
    const caches = await window.caches.keys();
    const cachedUrls: string[] = [];
    for (const key of caches) {
      const cache = await window.caches.open(key);
      cachedUrls.push(...(await cache.keys()).map(request => request.url));
    }
    return { caches, cachedUrls, localStorage: Object.keys(window.localStorage) };
  });
  expect(persistence.cachedUrls.filter(url => /\/api\//.test(url))).toEqual([]);
  expect(persistence.localStorage.filter(key => /token|session|auth/i.test(key))).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  await mkdir('/tmp/opencode', { recursive: true });
  await page.screenshot({ path: '/tmp/opencode/phantom-auth-desktop.png', fullPage: true, animations: 'disabled' });
});
