// @vitest-environment jsdom
// The Releases panel page in a DOM: it renders the state the plugin publishes
// as text, asks the host to run the plugin's commands, and refreshes on its own
// while it is open.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelState } from "./plugin.ts";

const dir = `${import.meta.dirname}/../panels/releases`;
const html = readFileSync(`${dir}/index.html`, "utf8");
const script = readFileSync(`${dir}/app.js`, "utf8");

const NOW = Date.parse("2026-10-16T12:00:00Z");
const MINUTE = 60_000;

function release(tag: string, publishedAt: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    tag,
    version: tag.replace(/^v/, ""),
    name: "",
    firstLine: "",
    url: `https://github.com/rim-platform/rim-ui/releases/tag/${tag}`,
    publishedAt,
    prerelease: false,
    ...extra,
  };
}

const STATE: PanelState = {
  repos: [
    {
      repo: "rim-platform/rim-ui",
      error: null,
      releases: [
        release("v0.0.3-rc.1", "2026-10-16T09:00:00Z", {
          name: "<img src=x onerror=alert(1)>",
          prerelease: true,
        }),
        release("v0.0.2", "2026-10-12T09:00:00Z"),
        release("v0.0.1", "2026-10-01T09:00:00Z"),
      ],
    },
    { repo: "rim-platform/plugin-github-prs", error: null, releases: [] },
    { repo: "acme/private", error: "acme/private was not found, or it is private.", releases: [] },
  ],
  maxRepos: 10,
  fetchedAt: new Date(NOW).toISOString(),
  loading: false,
  notice: null,
  signedIn: true,
};

let sent: Array<Record<string, unknown>>;
let added: Array<() => void>;

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

function clock(ms: number) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  sent = [];
  added = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      add(type, listener, options);
      added.push(() => target.removeEventListener(type, listener, options));
    });
  }
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as Record<string, unknown>);
  });
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[^>]*><\/script>/, "");
  new Function(script)();
});

afterEach(() => {
  for (const remove of added) remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Releases panel", () => {
  it("renders each repository's latest release and counts the earlier ones, as text, with no links", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    const sections = [...document.querySelectorAll("section")];
    expect(sections.map((s) => s.querySelector(".name")?.textContent)).toEqual([
      "rim-platform/rim-ui",
      "rim-platform/plugin-github-prs",
      "acme/private",
    ]);
    const latest = sections[0].querySelector(".latest");
    expect(latest?.querySelector(".version")?.textContent).toBe("0.0.3-rc.1");
    expect(latest?.querySelector(".badge")?.textContent).toBe("pre-release");
    expect(latest?.querySelector(".meta")?.textContent).toBe(" · 2026-10-16");
    expect(latest?.querySelector(".summary")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(sections[0].querySelector("img")).toBeNull();
    const earlier = sections[0].querySelector("details");
    expect(earlier?.open).toBe(false);
    expect(earlier?.querySelector("summary")?.textContent).toBe("2 earlier releases");
    expect([...(earlier?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      "0.0.2 · 2026-10-12",
      "0.0.1 · 2026-10-01",
    ]);
    expect(sections[1].querySelector(".none")?.textContent).toBe("No published release yet.");
    expect(sections[2].querySelector(".error")?.textContent).toBe(
      "acme/private was not found, or it is private.",
    );
    expect(sections[2].querySelector(".none")).toBeNull();
    expect(document.getElementById("refreshed")?.textContent).toBe(`Refreshed at ${clock(NOW)}`);
    expect(document.querySelector("a")).toBeNull();
  });

  it("ignores messages that do not come from the host", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "panel.state_update", state: STATE } }),
    );
    expect(document.querySelectorAll("section")).toHaveLength(0);
  });

  it("adds, removes and refreshes through the plugin's commands", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    const input = document.getElementById("repo") as HTMLInputElement;
    input.value = " tokio-rs/tokio ";
    document.getElementById("add")?.click();
    (document.querySelector("section h2 button") as HTMLButtonElement).click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    expect(sent.map((m) => [m.commandId, m.args])).toEqual([
      ["plugin.chat.rim.releases.add_repo", { repo: "tokio-rs/tokio" }],
      ["plugin.chat.rim.releases.remove_repo", { repo: "rim-platform/rim-ui" }],
      ["plugin.chat.rim.releases.refresh", {}],
    ]);
    fromHost({
      type: "rim.command.result",
      requestId: "releases-1",
      ok: false,
      message: "No room.",
    });
    expect(document.getElementById("notice")?.textContent).toBe("No room.");
    expect(input.value).toBe(" tokio-rs/tokio ");
  });

  it("refreshes every 10 minutes while it is open", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    vi.advanceTimersByTime(9 * MINUTE);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(MINUTE);
    expect(sent.map((m) => m.commandId)).toEqual(["plugin.chat.rim.releases.refresh"]);
    // The plugin answered without fetching (GitHub said wait): the next try is 10 minutes on.
    vi.advanceTimersByTime(9 * MINUTE);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(MINUTE);
    expect(sent).toHaveLength(2);
  });

  it("refreshes a list older than 10 minutes as soon as it opens, and never while loading", () => {
    const old = new Date(NOW - 11 * MINUTE).toISOString();
    fromHost({ type: "panel.state_update", state: { ...STATE, fetchedAt: old, loading: true } });
    expect(sent).toEqual([]);
    fromHost({ type: "panel.state_update", state: { ...STATE, fetchedAt: old } });
    expect(sent.map((m) => m.commandId)).toEqual(["plugin.chat.rim.releases.refresh"]);
  });

  it("shows GitHub's refusal and turns the form off when the list is full or nobody is signed in", () => {
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, notice: "GitHub refused: try again after 13:00.", maxRepos: 3 },
    });
    expect(document.getElementById("notice")?.hidden).toBe(false);
    expect(document.getElementById("notice")?.textContent).toBe(
      "GitHub refused: try again after 13:00.",
    );
    expect((document.getElementById("add") as HTMLButtonElement).disabled).toBe(true);
    fromHost({
      type: "panel.state_update",
      state: { ...STATE, repos: [], signedIn: false, fetchedAt: null },
    });
    expect(document.getElementById("empty")?.textContent).toBe(
      "Sign in to keep a list of repositories.",
    );
    expect(document.getElementById("refreshed")?.textContent).toBe("");
    vi.advanceTimersByTime(30 * MINUTE);
    expect(sent).toEqual([]);
  });

  it("says the plugin stopped once its state goes away", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    fromHost({ type: "panel.state_update", state: null });
    expect(document.querySelectorAll("section")).toHaveLength(0);
    expect(document.getElementById("empty")?.textContent).toBe("The plugin stopped.");
    vi.advanceTimersByTime(30 * MINUTE);
    expect(sent).toEqual([]);
  });
});
