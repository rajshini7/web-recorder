import "dotenv/config";
import { chromium, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";
import {
  sendFailureEmail,
  buildMinimalFailureEmail,
} from "./utils/email";

/* ================= TYPES ================= */

type ContentSnapshot = {
  title?: string;
  h1?: string;
  firstP?: string;
  metaDescription?: string;
  bodySnippet?: string;
};

type Step = {
  selector: string | null;
  url: string;
  target_href: string;
  content: ContentSnapshot;
  timestamp: number;
};

type StepResult = Step & {
  liveContent: ContentSnapshot;
  pass: boolean;
};

/* ================= PATHS ================= */

const OUT_DIR = path.join(process.cwd(), "steps");
const OUT_FILE = path.join(OUT_DIR, "steps.json");
const REPORT_FILE = path.join(process.cwd(), "replay-report.html");

/* ================= HELPERS ================= */

function loadSteps(): Step[] {
  if (!fs.existsSync(OUT_FILE)) {
    throw new Error(`${OUT_FILE} not found. Run recorder first.`);
  }
  return JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) as Step[];
}

function normalize(s?: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/* ================= CONTENT EXTRACTION ================= */

async function extractContent(page: Page): Promise<ContentSnapshot> {
  return page.evaluate(() => {
    function extractFirstP(): string {
      const root = document.querySelector("#mw-content-text");
      const candidates: HTMLParagraphElement[] = [];

      if (root) candidates.push(...Array.from(root.querySelectorAll("p")));
      candidates.push(...Array.from(document.querySelectorAll("p")));

      for (const p of candidates) {
        const txt = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (txt.length > 40) return txt;
      }

      return document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 200);
    }

    return {
      title: document.title || "",
      h1: (document.querySelector("h1")?.textContent || "").trim(),
      firstP: extractFirstP(),
      metaDescription:
        (document.querySelector('meta[name="description"]') as HTMLMetaElement)
          ?.content || "",
    };
  });
}

/* ================= MAIN ================= */

(async function main() {
  const steps = loadSteps();
  if (!steps.length) {
    console.log("No recorded steps found.");
    return;
  }

  const results: StepResult[] = [];
  let failureEmailSent = false;

  const browser: Browser = await chromium.launch({
    headless: false,
    slowMo: 120,
  });

  const context = await browser.newContext();
  const page: Page = await context.newPage();

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      console.log(`\n▶ Step ${i + 1}`);
      console.log(`Opening: ${step.target_href}`);

      await page.goto(step.target_href, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      await page.waitForTimeout(1500);

      const live = await extractContent(page);

      const recordedFP = normalize(step.content.firstP);
      const liveFP = normalize(live.firstP);
      const pass = recordedFP === liveFP;

      results.push({
        ...step,
        liveContent: live,
        pass,
      });

      if (!pass && !failureEmailSent) {
        failureEmailSent = true;

        await sendFailureEmail(
          "❌ Web Replay Verification Failed",
          buildMinimalFailureEmail({
            step: i + 1,
            url: step.target_href,
            recordedFirstP: recordedFP || "<empty>",
            liveFirstP: liveFP || "<empty>",
          })
        );
      }

      await page.waitForTimeout(600);
    }
  } catch (err) {
    console.error("Replay crashed:", err);

    if (!failureEmailSent) {
      await sendFailureEmail(
        "🔥 Web Replay Crashed",
        buildMinimalFailureEmail({
          step: -1,
          url: "N/A",
          recordedFirstP: "",
          liveFirstP: "",
          reason: "Browser closed unexpectedly or script crashed",
        })
      );
    }
  } finally {
    await browser.close();
  }

  /* ================= REPORT ================= */

  const reportHtml = `
<html>
<head>
  <title>Replay Report</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .step { border: 1px solid #ccc; margin-bottom: 15px; padding: 10px; }
    .pass { color: green; font-weight: bold; }
    .fail { color: red; font-weight: bold; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Web Replay Report</h1>
  ${results
    .map(
      (r, i) => `
    <div class="step">
      <h2>Step ${i + 1} — ${
        r.pass
          ? '<span class="pass">PASS</span>'
          : '<span class="fail">FAIL</span>'
      }</h2>
      <p><strong>Opened URL:</strong> ${r.target_href}</p>
      <pre>${r.content.firstP}</pre>
      <pre>${r.liveContent.firstP}</pre>
    </div>
  `
    )
    .join("")}
</body>
</html>
`;

  fs.writeFileSync(REPORT_FILE, reportHtml);
  console.log("\n✅ Replay finished.");
})();
