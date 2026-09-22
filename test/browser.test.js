import test from "node:test";
import assert from "node:assert/strict";
import { openGameBrowser } from "../src/browser.js";

function existingBrowser(urls) {
  const calls = [];
  const context = {
    pages: () => pages,
    close: async () => assert.fail("The user's browser must stay open"),
    newPage: async () => assert.fail("Attach must preserve existing tabs"),
  };
  const pages = urls.map((url) => ({
    url: () => url,
    context: () => context,
    goto: async () => assert.fail("Attach must not reload a logged-in page"),
  }));
  return {
    calls,
    pages,
    browserType: {
      connectOverCDP: async (endpoint, options) => {
        calls.push({ endpoint, options });
        return {
          contexts: () => [context],
          close: async () => calls.push("disconnect"),
        };
      },
      launchPersistentContext: async () =>
        assert.fail("Attach must not launch a replacement browser"),
    },
  };
}

test("attach selects the game tab, preserves its session, and only disconnects on exit", async () => {
  const browser = existingBrowser([
    "about:blank",
    "https://evades.io/profile/example",
    "https://evades.io.example.com/",
    "https://evades.io/",
  ]);
  const session = await openGameBrowser({ attach: true }, browser.browserType);
  assert.equal(session.page, browser.pages[3]);
  assert.equal(session.attached, true);
  assert.equal(browser.calls[0].endpoint, "chrome");
  assert.equal(browser.calls[0].options.noDefaults, true);
  await session.close();
  assert.equal(browser.calls.at(-1), "disconnect");
});

test("attach refuses missing or ambiguous game tabs without closing the browser", async () => {
  for (const [urls, error] of [
    [["https://evades.io/profile/example"], /No Evades game tab/],
    [["https://evades.io/", "https://evades.io/#another"], /Multiple Evades/],
  ]) {
    const browser = existingBrowser(urls);
    await assert.rejects(
      openGameBrowser({ attach: true }, browser.browserType),
      error,
    );
    assert.equal(browser.calls.at(-1), "disconnect");
  }
});

test("local debugging endpoints attach without launching or navigating", async () => {
  const browser = existingBrowser(["https://evades.io/"]);
  const session = await openGameBrowser(
    { cdpUrl: "http://127.0.0.1:9222" },
    browser.browserType,
  );
  assert.equal(browser.calls[0].endpoint, "http://127.0.0.1:9222/");
  assert.equal(session.page, browser.pages[0]);
  await session.close();
});

test("Ravel attach selects only the Ravel game and preserves the Evades tab", async () => {
  const browser = existingBrowser(["https://evades.io/", "https://pifary-dev.github.io/ravel/",
    "https://pifary-dev.github.io/", "https://pifary-dev.github.io/ravel.example/",
    "https://pifary-dev.github.io.evil.example/ravel/"]);
  const session = await openGameBrowser({ attach:true, game:"ravel" }, browser.browserType);
  assert.equal(session.page, browser.pages[1]);
  await session.close();
  const missing = existingBrowser(["https://evades.io/"]);
  await assert.rejects(openGameBrowser({ attach:true, game:"ravel" }, missing.browserType), /No Ravel/);
});

test("Ravel launch uses its own profile and URL", async () => {
  let opened;
  const session = await openGameBrowser({ game:"ravel" }, {
    launchPersistentContext: async (profile) => {
      assert.ok(profile.endsWith(".ravel-browser-profile"));
      return { pages:()=>[{goto:async url=>{opened=url;}}],close:async()=>{} };
    },
  });
  assert.equal(opened,"https://pifary-dev.github.io/ravel/");
  await session.close();
});

test("invalid attach options are rejected before connecting", async () => {
  for (const options of [
    { attach: true, cdpUrl: "http://127.0.0.1:9222" },
    { attach: true, headless: true },
    { cdpUrl: "http://127.0.0.1:9222", headless: true },
    { cdpUrl: "https://example.com" },
    { cdpUrl: "file:///tmp/debug" },
    { cdpUrl: "http://name:secret@localhost:9222" },
    { cdpUrl: "invalid" },
  ]) {
    const browser = existingBrowser(["https://evades.io/"]);
    await assert.rejects(openGameBrowser(options, browser.browserType));
    assert.equal(browser.calls.length, 0);
  }
});

test("a failed new-browser navigation closes only the browser the controller launched", async () => {
  let closed = false;
  const sessionError = new Error("navigation failed");
  const browserType = {
    launchPersistentContext: async () => ({
      pages: () => [
        {
          goto: async () => {
            throw sessionError;
          },
        },
      ],
      close: async () => {
        closed = true;
      },
    }),
  };
  await assert.rejects(openGameBrowser({}, browserType), sessionError);
  assert.equal(closed, true);
});
