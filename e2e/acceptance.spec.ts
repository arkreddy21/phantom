import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function readApiState(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('fresh history, practice rewards, reflections, custom practice, and mobile settings', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(5);
  await expect(page.locator('.note-right')).toHaveText('0 OF 5 DONE');

  const initialState = await readApiState(page);
  expect(initialState.entries).toHaveLength(0);
  expect(initialState.habits).toHaveLength(5);
  await page.screenshot({ path: testInfo.outputPath('fresh-desktop.png'), fullPage: true, animations: 'disabled' });

  // A completion awards once, remains after a reload, and undo removes the points.
  await page.getByRole('button', { name: 'Complete Read 20 minutes' }).click();
  const firstReward = page.getByRole('dialog', { name: /10 Knowledge points earned/i });
  await expect(firstReward).toBeVisible();
  await expect(firstReward.getByText('+10')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reward.png'), fullPage: true, animations: 'disabled' });
  const rewardDismiss = firstReward.getByRole('button', { name: /Back to my day/i });
  await rewardDismiss.focus();
  await page.keyboard.press('Tab');
  await expect(rewardDismiss).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(rewardDismiss).toBeFocused();
  await firstReward.getByRole('button', { name: /Back to my day/i }).click();

  await page.getByRole('button', { name: 'Stats' }).click();
  const knowledgeCard = page.locator('.stat-card').filter({ hasText: 'Knowledge' });
  await expect(knowledgeCard.locator('.stat-card-total')).toContainText('10');
  await page.reload();
  await page.getByRole('button', { name: 'Stats' }).click();
  await expect(page.locator('.stat-card').filter({ hasText: 'Knowledge' }).locator('.stat-card-total')).toContainText('10');
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Undo Read 20 minutes' }).click();
  await expect(page.getByText('0 OF 5 DONE')).toBeVisible();
  await page.getByRole('button', { name: 'Stats' }).click();
  await expect(page.locator('.stat-card').filter({ hasText: 'Knowledge' }).locator('.stat-card-total')).toContainText('0');

  // Select a past date, save optional reflection there, and browse that date in the archive.
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByText('LOOKING BACK')).toBeVisible();
  const pastDates = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return {
      iso: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      display: date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    };
  });
  const readPractice = page.locator('.habit-card').filter({ hasText: 'Read 20 minutes' });
  await readPractice.getByRole('button', { name: /Add a reflection/ }).click();
  const noteDialog = page.getByRole('dialog', { name: 'A note for this day.' });
  await noteDialog.getByLabel('Anything you want to remember?').fill('A few pages before bed.');
  await noteDialog.getByLabel('Something good').fill('The story made me smile.');
  await noteDialog.getByLabel('Something hard').fill('I was tired.');
  await noteDialog.getByLabel('Something to try tomorrow').fill('Read outside.');
  await noteDialog.getByRole('button', { name: 'Save note' }).click();
  await expect(noteDialog).toBeVisible();
  await noteDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Archive' }).click();
  const archiveHeading = page.locator('.month-control h2');
  const monthBefore = await archiveHeading.textContent();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(archiveHeading).not.toHaveText(monthBefore || '');
  await page.getByRole('button', { name: 'Next month' }).click();
  const readCalendar = page.getByRole('grid', { name: /Read 20 minutes in/ });
  await readCalendar.getByRole('button', { name: new RegExp(`${pastDates.display}, entry saved`) }).click();
  const pastNoteDialog = page.getByRole('dialog', { name: 'A note for this day.' });
  await expect(pastNoteDialog.getByLabel('Anything you want to remember?')).toHaveValue('A few pages before bed.');
  await expect(page.getByRole('dialog', { name: /10 Knowledge points earned/i })).toHaveCount(0);
  await pastNoteDialog.getByRole('button', { name: 'Cancel' }).click();
  const afterOptionalReflection = await readApiState(page);
  expect(afterOptionalReflection.entries.find((entry: { habitId: string; date: string }) => entry.habitId === 'read-20-minutes' && entry.date === pastDates.iso)).toMatchObject({
    completed: false,
    awardedPoints: 0,
    content: 'A few pages before bed.',
    good: 'The story made me smile.',
    bad: 'I was tired.',
    improve: 'Read outside.',
  });

  // Prompted writing cannot be completed empty; the saved entry is browsable and editable.
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Complete Gratitude' }).click();
  const journal = page.getByRole('dialog', { name: 'A moment to reflect.' });
  await expect(journal.getByText('What are you grateful for today?')).toBeVisible();
  const saveJournal = journal.getByRole('button', { name: 'Save & complete' });
  await expect(saveJournal).toBeDisabled();
  const reflection = journal.getByLabel('Your reflection');
  await reflection.fill('I am grateful for a quiet morning.');
  await expect(saveJournal).toBeEnabled();
  await saveJournal.click();
  const journalReward = page.getByRole('dialog', { name: /10 Kindness points earned/i });
  await expect(journalReward).toBeVisible();
  await journalReward.getByRole('button', { name: /Back to my day/i }).click();
  await expect(journal).toHaveCount(0);
  await page.getByRole('button', { name: /I am grateful for a quiet morning/ }).click();
  await expect(journal).toBeVisible();
  await expect(journal.getByLabel('Your reflection')).toHaveValue('I am grateful for a quiet morning.');
  await journal.getByLabel('Your reflection').fill('I am grateful for a slow, sunny morning.');
  await journal.getByRole('button', { name: 'Save reflection' }).click();
  await expect(page.getByRole('dialog', { name: /10 Kindness points earned/i })).toHaveCount(0);
  await expect(journal).toBeVisible();
  await journal.getByRole('button', { name: 'Cancel' }).click();

  const afterJournalEdit = await readApiState(page);
  expect(afterJournalEdit.entries.filter((entry: { habitId: string }) => entry.habitId === 'gratitude')).toHaveLength(1);
  expect(afterJournalEdit.entries.find((entry: { habitId: string }) => entry.habitId === 'gratitude')).toMatchObject({
    completed: true,
    content: 'I am grateful for a slow, sunny morning.',
    awardedPoints: 10,
  });

  await page.getByRole('button', { name: 'Archive' }).click();
  await page.screenshot({ path: testInfo.outputPath('archive.png'), fullPage: true, animations: 'disabled' });
  const gratitudeCalendar = page.getByRole('grid', { name: /Gratitude in/ });
  await gratitudeCalendar.getByRole('button', { name: new RegExp(`${pastDates.display}, completed`) }).click();
  await expect(page.getByRole('dialog', { name: 'A moment to reflect.' }).getByLabel('Your reflection')).toHaveValue('I am grateful for a slow, sunny morning.');
  await page.getByRole('dialog', { name: 'A moment to reflect.' }).getByRole('button', { name: 'Cancel' }).click();

  // Add a stat and a custom check practice, then verify its selected reward.
  await page.getByRole('button', { name: 'Stats' }).click();
  await page.screenshot({ path: testInfo.outputPath('stats.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Add a stat' }).click();
  const statDialog = page.getByRole('dialog', { name: 'What are you growing?' });
  await statDialog.getByLabel('Stat name').fill('Creativity');
  await statDialog.getByRole('button', { name: 'Add stat' }).click();
  await expect(statDialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Add a practice' }).click();
  const practiceDialog = page.getByRole('dialog', { name: 'Make room for something.' });
  await practiceDialog.getByLabel('Practice name').fill('Sketch for ten minutes');
  await practiceDialog.getByLabel('Build which stat?').selectOption({ label: 'Creativity' });
  await practiceDialog.getByLabel('Points').fill('23');
  await practiceDialog.getByRole('button', { name: 'Add practice' }).click();
  await expect(practiceDialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Complete Sketch for ten minutes' }).click();
  const customReward = page.getByRole('dialog', { name: /23 Creativity points earned/i });
  await expect(customReward).toBeVisible();
  await customReward.getByRole('button', { name: /Back to my day/i }).click();

  // Archive and restore through its archive card management entry point.
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Edit or archive Sketch for ten minutes' }).click();
  const editCustomHabit = page.getByRole('dialog', { name: 'Shape this practice.' });
  await editCustomHabit.getByRole('button', { name: 'Archive' }).click();
  await editCustomHabit.getByRole('button', { name: 'Confirm archive' }).click();
  await expect(editCustomHabit).toHaveCount(0);
  await expect(page.locator('.calendar-label').filter({ hasText: 'Sketch for ten minutes' })).toContainText('archived');
  await page.getByRole('button', { name: 'Edit or restore Sketch for ten minutes' }).click();
  const restoreCustomHabit = page.getByRole('dialog', { name: 'Shape this practice.' });
  await restoreCustomHabit.getByRole('button', { name: 'Restore' }).click();
  await restoreCustomHabit.getByRole('button', { name: 'Restore practice' }).click();
  await expect(restoreCustomHabit).toHaveCount(0);
  await expect(page.locator('.calendar-label').filter({ hasText: 'Sketch for ten minutes' })).not.toContainText('archived');

  await page.getByRole('button', { name: 'Stats' }).click();
  await expect(page.locator('.stat-card').filter({ hasText: 'Creativity' }).locator('.stat-card-total')).toContainText('23');

  // Sound preference persists; settings remains keyboard-dismissible.
  await page.getByRole('button', { name: 'Settings' }).click();
  const soundSwitch = page.getByRole('switch', { name: 'Reward sound' });
  const motionSwitch = page.getByRole('switch', { name: 'Reduce motion' });
  await expect(soundSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(motionSwitch).toHaveAttribute('aria-checked', 'false');
  await soundSwitch.click();
  await motionSwitch.click();
  await expect(soundSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(motionSwitch).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Your data, your call.' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: 'Reward sound' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: 'Reduce motion' })).toHaveAttribute('aria-checked', 'true');
  // Export a backup, then restore that exact file through the explicit confirmation flow.
  const settingsDialog = page.getByRole('dialog', { name: 'Your data, your call.' });
  const downloadPromise = page.waitForEvent('download');
  await settingsDialog.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('phantom-backup.json');
  await download.saveAs(backupPath);
  const backupData = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backupData.entries).toHaveLength(4);
  await settingsDialog.locator('input[type="file"]').setInputFiles(backupPath);
  await settingsDialog.getByRole('button', { name: 'Continue' }).click();
  await expect(settingsDialog.getByRole('button', { name: 'Replace my data' })).toBeVisible();
  await settingsDialog.getByRole('button', { name: 'Replace my data' }).click();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  expect((await readApiState(page)).entries).toHaveLength(4);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Your practices.' })).toBeVisible();
  await expect(page.locator('.habit-card').last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-today.png'), fullPage: true, animations: 'disabled' });
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(dimensions.scrollWidth, `horizontal overflow at 375px: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewportWidth);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Archive' })).toBeVisible();
  expect(pageErrors, 'uncaught browser page errors').toEqual([]);
  expect(consoleErrors, 'browser console errors').toEqual([]);
});
