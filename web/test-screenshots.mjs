import { chromium } from '@playwright/test';
import fs from 'fs';

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  console.log('Navigating to http://localhost:3300 ...');
  await page.goto('http://localhost:3300', { waitUntil: 'networkidle' });

  fs.mkdirSync('./screenshots', { recursive: true });

  // 1. Hero at scroll 0
  await page.waitForTimeout(1000);
  await page.screenshot({ path: './screenshots/01-hero.png' });
  console.log('Saved 01-hero.png');

  // 2. PPE Detection at scroll 1050
  await page.evaluate(() => window.scrollTo({ top: 1050, behavior: 'instant' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './screenshots/02-ppe.png' });
  console.log('Saved 02-ppe.png');

  // 3. Behavior Recognition at scroll 2050
  await page.evaluate(() => window.scrollTo({ top: 2050, behavior: 'instant' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './screenshots/03-behavior.png' });
  console.log('Saved 03-behavior.png');

  // 4. System Pipeline at scroll 2760
  await page.evaluate(() => window.scrollTo({ top: 2760, behavior: 'instant' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './screenshots/04-pipeline.png' });
  console.log('Saved 04-pipeline.png');

  // 5. Capability Slider at scroll 3350
  await page.evaluate(() => window.scrollTo({ top: 3350, behavior: 'instant' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './screenshots/05-capabilities.png' });
  console.log('Saved 05-capabilities.png');

  // 6. Closing Section
  await page.evaluate(() => document.getElementById('closing')?.scrollIntoView({ behavior: 'instant' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: './screenshots/06-closing.png' });
  console.log('Saved 06-closing.png');

  // 7. Test Mobile Viewport
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/07-mobile-hero.png' });
  console.log('Saved 07-mobile-hero.png');

  await page.evaluate(() => window.scrollTo({ top: 1050, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/08-mobile-ppe.png' });
  console.log('Saved 08-mobile-ppe.png');

  await page.evaluate(() => window.scrollTo({ top: 2050, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/09-mobile-behavior.png' });
  console.log('Saved 09-mobile-behavior.png');

  await page.evaluate(() => window.scrollTo({ top: 2760, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/10-mobile-pipeline.png' });
  console.log('Saved 10-mobile-pipeline.png');

  await page.evaluate(() => window.scrollTo({ top: 3350, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/11-mobile-capabilities.png' });
  console.log('Saved 11-mobile-capabilities.png');

  // Desktop Modals
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('LIVE SYSTEM'));
    btn?.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/12-demo-modal.png' });
  console.log('Saved 12-demo-modal.png');

  await page.evaluate(() => {
    const close = document.querySelector('.close-button');
    close?.click();
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Explore Detection Results'));
    btn?.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/13-results-modal.png' });
  console.log('Saved 13-results-modal.png');

  await page.evaluate(() => {
    const close = document.querySelector('.close-button');
    close?.click();
  });
  await page.waitForTimeout(300);

  // 14. Open Auth Modal (Đăng nhập)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Đăng nhập');
    btn?.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/14-auth-signin.png' });
  console.log('Saved 14-auth-signin.png');

  // 15. Switch to Đăng ký
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.auth-dialog .branch-tabs button')).find(b => b.textContent?.includes('Đăng ký'));
    tab?.click();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/15-auth-signup.png' });
  console.log('Saved 15-auth-signup.png');

  // 16. Switch back to Đăng nhập and click quick login
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.auth-dialog .branch-tabs button')).find(b => b.textContent?.includes('Đăng nhập'));
    tab?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const quickBtn = Array.from(document.querySelectorAll('.quick-buttons button')).find(b => b.textContent?.includes('EHS Director'));
    quickBtn?.click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: './screenshots/16-logged-in-header.png' });
  console.log('Saved 16-logged-in-header.png');

  await browser.close();
  console.log('Finished with errors:', errors);
}

run().catch(console.error);
