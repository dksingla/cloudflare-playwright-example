import { launch } from "@cloudflare/playwright";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function looksLikeCloudflareChallenge(html: string): boolean {
  // Common markers in CF challenge/interstitial pages
  return (
    html.includes("/cdn-cgi/challenge-platform/") ||
    html.includes("cf_chl_opt") ||
    html.includes("__cf_chl_rt_tk=") ||
    html.includes("Ray ID:") ||
    html.includes("Performance and Security by Cloudflare")
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function gotoWithRetries(
  page: import("@cloudflare/playwright").Page,
  targetUrl: string,
): Promise<import("@cloudflare/playwright").Response | null> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const navResponse = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      // Extra time for JS challenges / late scripts
      await page.waitForTimeout(5_000);

      // Simulate basic human-ish behavior
      await page.mouse.move(100, 100);
      await page.waitForTimeout(1_000);
      await page.mouse.move(300, 400);

      // Scroll once to trigger lazy-loading / challenge completion
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(2_000);

      return navResponse;
    } catch (err: unknown) {
      lastError = err;
      await page.waitForTimeout(3_000);
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : "Unknown error";
  throw new Error(`Failed to navigate after 3 attempts: ${message}`);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname !== "/") return new Response(null, { status: 404 });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return jsonResponse(
        { error: "Missing ?url= parameter" },
        { status: 400 },
      );
    }
    if (!isValidHttpUrl(targetUrl)) {
      return jsonResponse(
        { error: "Invalid url (must be http/https)" },
        { status: 400 },
      );
    }

    const browser = await launch(env.MYBROWSER);
    const context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      locale: "en-US",
    });
    const page = await context.newPage();

    try {
      const navResponse = await gotoWithRetries(page, targetUrl);

      const html = await page.content();
      const title = await page.title();

      const links = await page.$$eval("a", (els) =>
        els
          .map((e) => e.getAttribute("href"))
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      );
      const h1s = await page.$$eval("h1", (els) =>
        els
          .map((e) => (e.textContent ?? "").trim())
          .filter((t) => t.length > 0),
      );
      const metaDescription = await page
        .$eval('meta[name="description"]', (el) => el.getAttribute("content"))
        .catch(() => null);

      const headers = navResponse ? navResponse.headers() : {};
      const status = navResponse ? navResponse.status() : null;
      const finalUrl = navResponse ? navResponse.url() : page.url();

      const cfMitigated =
        typeof headers["cf-mitigated"] === "string"
          ? headers["cf-mitigated"]
          : null;
      const cfRay =
        typeof headers["cf-ray"] === "string" ? headers["cf-ray"] : null;

      if (cfMitigated === "challenge" || looksLikeCloudflareChallenge(html)) {
        return jsonResponse(
          {
            error: "Cloudflare challenge page returned (bot mitigation)",
            url: targetUrl,
            finalUrl,
            status,
            title,
            cf: {
              mitigated: cfMitigated,
              ray: cfRay,
            },
            // Keep the HTML for debugging/pipeline decisions.
            html,
            headers,
          },
          { status: 403 },
        );
      }

      return jsonResponse(
        {
          url: targetUrl,
          finalUrl,
          status,
          title,
          html,
          headers,
          links,
          h1s,
          metaDescription,
        },
        { status: 200 },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse({ error: message }, { status: 500 });
    } finally {
      await context.close();
      await browser.close();
    }
  },
};
