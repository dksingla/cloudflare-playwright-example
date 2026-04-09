import { launch, limits } from "@cloudflare/playwright";

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

function withRequestId(headers: Headers, requestId: string): void {
  headers.set("X-Request-Id", requestId);
}

function jsonResponseWithRequestId(
  body: unknown,
  requestId: string,
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  withRequestId(headers, requestId);
  return jsonResponse(body, { ...init, headers });
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

async function launchWithRetries(
  env: Env,
): Promise<import("@cloudflare/playwright").Browser> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const started = Date.now();
      // keep_alive reduces repeated cold-start/acquire churn for short bursts
      const browser = await launch(env.MYBROWSER, {
        keep_alive: 120_000,
        recording: false,
      });
      console.log(
        JSON.stringify({
          at: "browser.launch.ok",
          attempt: attempt + 1,
          durationMs: Date.now() - started,
        }),
      );
      return browser;
    } catch (err: unknown) {
      lastError = err;
      // If Browser Rendering is temporarily overloaded/unavailable, back off briefly.
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : "Unknown error";
  throw new Error(`Failed to launch browser after 3 attempts: ${message}`);
}

export default {
  async fetch(request: Request, env: Env) {
    const requestId = crypto.randomUUID();
    const requestStarted = Date.now();
    const url = new URL(request.url);

    if (url.pathname !== "/") return new Response(null, { status: 404 });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponseWithRequestId(
        { error: "Method not allowed" },
        requestId,
        { status: 405 },
      );
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return jsonResponseWithRequestId(
        { error: "Missing ?url= parameter" },
        requestId,
        { status: 400 },
      );
    }
    if (!isValidHttpUrl(targetUrl)) {
      return jsonResponseWithRequestId(
        { error: "Invalid url (must be http/https)" },
        requestId,
        { status: 400 },
      );
    }

    console.log(
      JSON.stringify({
        at: "request.start",
        requestId,
        method: request.method,
        targetUrl,
      }),
    );

    // Surface Browser Rendering limits in logs and avoid predictable timeouts.
    try {
      const l = await limits(env.MYBROWSER);
      console.log(
        JSON.stringify({
          at: "browser.limits",
          requestId,
          activeSessions: l.activeSessions.length,
          maxConcurrentSessions: l.maxConcurrentSessions,
          allowedBrowserAcquisitions: l.allowedBrowserAcquisitions,
          timeUntilNextAllowedBrowserAcquisition:
            l.timeUntilNextAllowedBrowserAcquisition,
        }),
      );

      if (
        l.allowedBrowserAcquisitions === 0 ||
        l.activeSessions.length >= l.maxConcurrentSessions
      ) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(l.timeUntilNextAllowedBrowserAcquisition / 1000),
        );
        console.warn(
          JSON.stringify({
            at: "browser.throttled",
            requestId,
            retryAfterSeconds,
          }),
        );
        return jsonResponseWithRequestId(
          {
            error: "Browser Rendering throttled; retry later",
            retryAfterSeconds,
            limits: l,
          },
          requestId,
          {
            status: 429,
            headers: {
              "Retry-After": String(retryAfterSeconds),
            },
          },
        );
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        JSON.stringify({
          at: "browser.limits.error",
          requestId,
          message,
        }),
      );
    }

    const browser = await launchWithRetries(env);
    const context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      locale: "en-US",
    });
    const page = await context.newPage();

    try {
      const gotoStarted = Date.now();
      const navResponse = await gotoWithRetries(page, targetUrl);
      console.log(
        JSON.stringify({
          at: "page.goto.done",
          requestId,
          durationMs: Date.now() - gotoStarted,
          finalUrl: navResponse ? navResponse.url() : page.url(),
          status: navResponse ? navResponse.status() : null,
        }),
      );

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
        console.warn(
          JSON.stringify({
            at: "cf.challenge",
            requestId,
            cfMitigated,
            cfRay,
          }),
        );
        return jsonResponseWithRequestId(
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
          requestId,
          { status: 403 },
        );
      }

      console.log(
        JSON.stringify({
          at: "request.ok",
          requestId,
          durationMs: Date.now() - requestStarted,
        }),
      );
      return jsonResponseWithRequestId(
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
        requestId,
        { status: 200 },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(
        JSON.stringify({
          at: "request.error",
          requestId,
          message,
          stack,
          durationMs: Date.now() - requestStarted,
        }),
      );
      return jsonResponseWithRequestId({ error: message }, requestId, {
        status: 500,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  },
};
