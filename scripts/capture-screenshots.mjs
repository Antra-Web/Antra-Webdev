// scripts/capture-screenshots.mjs
//
// Visits every project in config/portfolio-projects.json with Playwright and
// saves a static .png thumbnail to assets/.
//
// Rules this script follows (see the workflow / README for the full picture):
//   - One project failing must NOT stop the others. Every project is wrapped
//     in its own try/catch.
//   - On failure, the previous screenshot file (if any) is left untouched —
//     we never overwrite a good screenshot with a blank/error/timeout image.
//   - After the run, assets/manifest.json is rewritten
//     with a short content hash per file, used by portfolio.html purely for
//     cache-busting (?v=<hash>) so browsers/CDNs pick up new screenshots
//     immediately without re-downloading unchanged ones.
//
// Usage: node scripts/capture-screenshots.mjs [projectName ...]
//   No args  -> capture every project in the config.
//   One+ args -> capture only the named project(s) (case-insensitive,
//                matches the "name" field) — used for the immediate,
//                single-project refresh path.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'config', 'portfolio-projects.json');
const PER_SITE_TIMEOUT_MS = 30_000; // navigation + settle budget per project
const SETTLE_DELAY_MS = 1800; // extra time for fonts/animations/lazy content to settle

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function captureOne(browser, project, screenshotDir, viewport) {
  const outPath = path.join(screenshotDir, project.screenshotFile);
  const tmpPath = outPath + '.tmp';

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36 PortfolioScreenshotBot/1.0',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(PER_SITE_TIMEOUT_MS);

  try {
    await page.goto(project.url, {
      waitUntil: 'domcontentloaded',
      timeout: PER_SITE_TIMEOUT_MS,
    });

    // Let webfonts finish loading so text doesn't screenshot mid-swap.
    await page
      .evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()))
      .catch(() => {});

    // Do not capture a site's loading screen. Some projects use a preloader
    // that disappears only after the homepage's first image has loaded.
    await page
      .waitForFunction(() => {
        const loaders = [...document.querySelectorAll(
          '.preloader, [class*="preloader"], [id*="preloader"]',
        )];
        return loaders.every((el) => {
          const style = getComputedStyle(el);
          return (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number.parseFloat(style.opacity || '1') < 0.1 ||
            el.classList.contains('hidden')
          );
        });
      }, { timeout: 15_000 })
      .catch(() => {});

    // Wait for images that can appear in the captured viewport. This prevents
    // a slow remote hero image from becoming a permanent blank thumbnail.
    await page
      .waitForFunction(() => {
        const images = [...document.images].filter((img) => {
          const rect = img.getBoundingClientRect();
          return (
            img.loading !== 'lazy' ||
            (rect.bottom > 0 && rect.top < window.innerHeight)
          );
        });
        return images.every((img) => img.complete && img.naturalWidth > 0);
      }, { timeout: 15_000 })
      .catch(() => {});

    // Give CSS animations / lazy images / JS-rendered content a moment to settle.
    await page.waitForTimeout(SETTLE_DELAY_MS);

    await page.screenshot({
      path: tmpPath,
      type: 'png',
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    });

    // Atomic-ish swap so a mid-write crash can't leave a corrupt thumbnail.
    await rename(tmpPath, outPath);

    return { project: project.name, status: 'success' };
  } catch (err) {
    // Never leave a half-written temp file or a broken/blank screenshot behind.
    if (existsSync(tmpPath)) await unlink(tmpPath).catch(() => {});
    const hadPrevious = existsSync(outPath);
    return {
      project: project.name,
      status: 'failed',
      error: err && err.message ? err.message : String(err),
      keptPreviousScreenshot: hadPrevious,
    };
  } finally {
    await context.close();
  }
}

async function fileHash(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

async function writeManifest(screenshotDir, projects) {
  const manifest = {};
  for (const project of projects) {
    const filePath = path.join(screenshotDir, project.screenshotFile);
    if (existsSync(filePath)) {
      manifest[project.screenshotFile] = await fileHash(filePath);
    }
  }
  manifest._generatedAt = new Date().toISOString();
  await writeFile(
    path.join(screenshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}

async function main() {
  const config = await loadConfig();
  const screenshotDir = path.join(ROOT, config.screenshotDir);
  await mkdir(screenshotDir, { recursive: true });

  const requested = process.argv.slice(2).map((s) => s.toLowerCase());
  const projects =
    requested.length === 0
      ? config.projects
      : config.projects.filter((p) => requested.includes(p.name.toLowerCase()));

  if (requested.length > 0 && projects.length === 0) {
    console.error(`No project name matched: ${requested.join(', ')}`);
    process.exit(1);
  }

  console.log(`Capturing ${projects.length} project(s)...`);

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const project of projects) {
      process.stdout.write(`  -> ${project.name} (${project.url}) ... `);
      const result = await captureOne(browser, project, screenshotDir, config.viewport);
      results.push(result);
      console.log(result.status === 'success' ? 'OK' : `FAILED (${result.error})`);
    }
  } finally {
    await browser.close();
  }

  const manifest = await writeManifest(screenshotDir, config.projects);

  const failures = results.filter((r) => r.status === 'failed');
  console.log('\n--- Summary ---');
  console.log(`Success: ${results.length - failures.length}/${results.length}`);
  if (failures.length > 0) {
    console.log('Failed (previous screenshot preserved where one existed):');
    for (const f of failures) {
      console.log(`  - ${f.project}: ${f.error}${f.keptPreviousScreenshot ? ' [kept previous]' : ' [no previous screenshot existed]'}`);
    }
  }

  // Write a machine-readable run summary for the workflow step to inspect.
  await writeFile(
    path.join(ROOT, 'screenshot-run-summary.json'),
    JSON.stringify({ results, manifest }, null, 2) + '\n',
  );

  // Exit 0 even if some sites failed — one broken site must never fail the
  // whole workflow or block the other screenshots from being committed.
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error running capture-screenshots.mjs:', err);
  process.exit(1);
});
