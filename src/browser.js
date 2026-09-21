import { resolve } from "node:path";
import { chromium } from "playwright";

const gameURL = "https://evades.io/";

function isGamePage(page) {
  try {
    const url = new URL(page.url());
    return url.origin === "https://evades.io" && url.pathname === "/";
  } catch {
    return false;
  }
}

function localEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--cdp-url must be a local Chrome debugging URL.");
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("--cdp-url must use localhost or a loopback IP address.");
  return url.href;
}

export async function openGameBrowser(
  { attach = false, cdpUrl, headless = false, channel = "chrome" } = {},
  browserType = chromium,
) {
  if (attach && cdpUrl)
    throw new Error("Use either --attach or --cdp-url, not both.");
  if ((attach || cdpUrl) && headless)
    throw new Error("--headless applies only when launching a new browser.");

  if (attach || cdpUrl) {
    const endpoint = attach ? "chrome" : localEndpoint(cdpUrl);
    const browser = await browserType.connectOverCDP(endpoint, {
      noDefaults: true,
      isLocal: true,
      timeout: 60000,
    });
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const matches = pages.filter(isGamePage);
      if (!matches.length)
        throw new Error(
          "No Evades game tab found. Open https://evades.io/ in that browser, log in, and run again.",
        );
      if (matches.length > 1)
        throw new Error(
          "Multiple Evades game tabs found. Keep one game tab open before attaching.",
        );
      const page = matches[0];
      return {
        page,
        context: page.context(),
        attached: true,
        // For a CDP connection, Browser.close disconnects our transport. Closing
        // the user's context instead would close their browser and its tabs.
        close: () => browser.close(),
      };
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  const context = await browserType.launchPersistentContext(
    resolve(".browser-profile"),
    { channel, headless, viewport: { width: 1440, height: 900 } },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(gameURL, { waitUntil: "domcontentloaded" });
    return { page, context, attached: false, close: () => context.close() };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
