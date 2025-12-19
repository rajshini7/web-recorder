// src/recorder.ts
import { chromium, Browser, Page, BrowserContext } from "playwright";
import fs from "fs";
import path from "path";

/* ================= TYPES ================= */

type ContentSnapshot = {
  title: string;
  h1: string;
  firstP: string;
  metaDescription: string;
};

type Step = {
  selector: string | null; // null for initial page
  url: string;             // page BEFORE click
  target_href: string;     // authoritative page snapshot
  content: ContentSnapshot;
  timestamp: number;
  isInitial?: boolean;
};

/* ================= PATHS ================= */

const OUT_DIR = path.join(process.cwd(), "baseline");
const OUT_FILE = path.join(OUT_DIR, "steps.json");

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function saveSteps(steps: Step[]) {
  ensureOutDir();
  fs.writeFileSync(OUT_FILE, JSON.stringify(steps, null, 2), "utf-8");
  console.log(`Saved ${steps.length} steps → ${OUT_FILE}`);
}

/* ================= CONTENT EXTRACTION ================= */
/**
 * Wikipedia-safe, NEVER-empty firstP
 */
async function extractContent(page: Page): Promise<ContentSnapshot> {
  await page.waitForLoadState("domcontentloaded");

  return page.evaluate(() => {
    const title = document.title || "";
    const h1 = document.querySelector("h1")?.textContent?.trim() || "";

    function extractFirstP(): string {
      const root = document.querySelector("#mw-content-text");
      const candidates: HTMLParagraphElement[] = [];

      if (root) {
        candidates.push(...Array.from(root.querySelectorAll("p")));
      }
      candidates.push(...Array.from(document.querySelectorAll("p")));

      for (const p of candidates) {
        const txt = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (txt.length > 40) return txt;
      }

      // hard fallback (guaranteed)
      return document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 200);
    }

    const metaDescription =
      (document.querySelector('meta[name="description"]') as HTMLMetaElement)
        ?.content || "";

    return {
      title,
      h1,
      firstP: extractFirstP(),
      metaDescription,
    };
  });
}

/* ================= MAIN ================= */

(async function main() {
  ensureOutDir();

  const browser: Browser = await chromium.launch({ headless: false });
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();

  const steps: Step[] = [];
  let shuttingDown = false;

  /* ===== graceful shutdown ===== */

  async function gracefulExit() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Saving steps and exiting…");
    saveSteps(steps);
    await browser.close();
    process.exit(0);
  }

  page.on("close", gracefulExit);
  context.on("close", gracefulExit);
  browser.on("disconnected", gracefulExit);
  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);

  /* ===== expose recorder binding ===== */

  await page.exposeBinding(
    "recordClick",
    async (_src, payload: { href: string; selector: string }) => {
      const fromUrl = page.url();
      const rawTarget = new URL(payload.href, fromUrl).href;

      if (!payload.selector || payload.selector === "a") return;

      console.log("\nCLICK");
      console.log(" From:", fromUrl);
      console.log(" To:", rawTarget);

      await page.goto(rawTarget, { waitUntil: "domcontentloaded" });

      const finalUrl = page.url();
      const content = await extractContent(page);

      const step: Step = {
        selector: payload.selector,
        url: fromUrl,
        target_href: finalUrl,
        content,
        timestamp: Date.now(),
      };

      steps.push(step);
      saveSteps(steps);
    }
  );

  /* ===== inject click listener ===== */

  await page.addInitScript(() => {
    if ((window as any).__recorderInstalled) return;
    (window as any).__recorderInstalled = true;

    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as HTMLElement)?.closest("a") as HTMLAnchorElement;
        if (!a || !a.href) return;

        let selector = "";
        if (a.id) selector = `a#${a.id}`;
        else if (a.getAttribute("href"))
          selector = `a[href="${a.getAttribute("href")}"]`;

        if (!selector) return;

        e.preventDefault();
        (window as any).recordClick({
          href: a.href,
          selector,
        });
      },
      true
    );
  });

  /* ===== START ===== */

  const startUrl = "https://en.wikipedia.org/wiki/Tiger";
  console.log("Opening:", startUrl);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // ✅ INITIAL PAGE SNAPSHOT (CRITICAL FIX)
  const initialContent = await extractContent(page);

  steps.push({
    selector: null,
    url: startUrl,
    target_href: page.url(),
    content: initialContent,
    timestamp: Date.now(),
    isInitial: true,
  });

  saveSteps(steps);

  console.log("📌 Initial page recorded:", page.url());
  console.log("Recorder running.");
  console.log("• Initial page included");
  console.log("• URL-driven navigation");
  console.log("• Deterministic replay");
  console.log("• Close browser to stop");
})();
