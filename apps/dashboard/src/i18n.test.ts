import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageCatalog, resolveLocale, supportedLocales, translate } from "./i18n.js";

describe("Dashboard i18n", () => {
  it("selects Chinese for every zh browser locale and English otherwise", () => {
    expect(resolveLocale(["zh-CN"])).toBe("zh-CN");
    expect(resolveLocale(["zh-Hans-CN", "en-GB"])).toBe("zh-CN");
    expect(resolveLocale(["zh-TW"])).toBe("zh-CN");
    expect(resolveLocale(["en-GB", "en"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });

  it("keeps a non-empty translation for every supported locale and message", () => {
    for (const [key, message] of Object.entries(messageCatalog)) {
      expect(Object.keys(message).sort(), key).toEqual([...supportedLocales].sort());
      for (const locale of supportedLocales) {
        expect(message[locale].trim().length, `${key}:${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates values without changing protocol identifiers", () => {
    expect(translate("en", "Copy UUID for {name}", { name: "prj_123" })).toBe(
      "Copy UUID for prj_123",
    );
    expect(translate("zh-CN", "Copy UUID for {name}", { name: "prj_123" })).toBe(
      "复制 prj_123 的 UUID",
    );
  });
});

describe("Dashboard language override", () => {
  const stored = new Map<string, string>();
  let languageReads = 0;
  let reloads = 0;

  // The module resolves its locale at load time, so each case has to import a fresh copy.
  async function loadI18n() {
    vi.resetModules();
    return import("./i18n.js");
  }

  beforeEach(() => {
    stored.clear();
    languageReads = 0;
    reloads = 0;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
      location: {
        reload: () => {
          reloads += 1;
        },
      },
    });
    vi.stubGlobal("navigator", {
      get languages() {
        languageReads += 1;
        return ["zh-CN"];
      },
      language: "zh-CN",
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("prefers a stored choice over the browser languages", async () => {
    stored.set("crossagent.locale", "en");
    const i18n = await loadI18n();
    expect(i18n.dashboardLocale()).toBe("en");
    expect(i18n.localeOverride()).toBe("en");
    expect(i18n.t("Loading live state")).toBe("Loading live state");
  });

  it("follows the browser when no choice is stored, and ignores an unsupported one", async () => {
    const following = await loadI18n();
    expect(following.dashboardLocale()).toBe("zh-CN");
    expect(following.localeOverride()).toBeNull();

    stored.set("crossagent.locale", "fr");
    const corrupt = await loadI18n();
    expect(corrupt.localeOverride()).toBeNull();
    expect(corrupt.dashboardLocale()).toBe("zh-CN");
  });

  it("reads the browser languages once, not on every translation", async () => {
    const i18n = await loadI18n();
    // Loading consults the browser -- the exact number of property reads is resolveLocale's
    // business. What matters is that the count stops growing from here.
    const readsAtLoad = languageReads;
    expect(readsAtLoad).toBeGreaterThan(0);
    for (let call = 0; call < 20; call += 1) i18n.t("Loading live state");
    i18n.localeTag();
    expect(languageReads).toBe(readsAtLoad);
  });

  it("persists a choice and clears it back to following the browser, reloading each time", async () => {
    const i18n = await loadI18n();
    i18n.setLocaleOverride("en");
    expect(stored.get("crossagent.locale")).toBe("en");
    expect(reloads).toBe(1);

    i18n.setLocaleOverride(null);
    expect(stored.has("crossagent.locale")).toBe(false);
    expect(reloads).toBe(2);
  });
});
