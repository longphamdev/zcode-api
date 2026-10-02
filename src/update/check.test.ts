/**
 * Tests for `src/update/check.ts` — the CLI/TUI update notice (issue #60).
 *
 * Every case injects a mock transport: the suite never touches the network,
 * and the "silent failure" contract (which the Android checker documents, and
 * which is why this module deliberately has no throwing path) is what most of
 * these assertions are about.
 */
import { describe, it, expect } from "bun:test";
import {
  LATEST_RELEASE_API,
  RELEASES_PAGE,
  buildUpdateNotice,
  checkForUpdate,
  fetchLatestRelease,
  isContainerRuntime,
  isNewerVersion,
  isSkippedVersion,
  parseVersion,
  updateCheckEnabled,
  type FetchLike,
} from "./check.js";

const RELEASE_URL = `${RELEASES_PAGE}/tag/v4.7.6`;
const BODY = { tag_name: "v4.7.6", html_url: RELEASE_URL, body: "release notes" };

function respondWith(body: unknown, status = 200): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function rejecting(): FetchLike {
  return async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
}

describe("isNewerVersion", () => {
  it("detects a newer patch/minor/major release", () => {
    expect(isNewerVersion("4.7.5", "v4.7.6")).toBe(true);
    expect(isNewerVersion("4.7.5", "v4.8.0")).toBe(true);
    expect(isNewerVersion("4.7.5", "v5.0.0")).toBe(true);
  });

  it("compares numerically, not as strings", () => {
    expect(isNewerVersion("4.7.5", "v4.10.0")).toBe(true);
    expect(isNewerVersion("4.9.0", "v4.10.0")).toBe(true);
    expect(isNewerVersion("4.7.10", "v4.7.9")).toBe(false);
  });

  it("is false for the same or an older tag", () => {
    expect(isNewerVersion("4.7.5", "v4.7.5")).toBe(false);
    expect(isNewerVersion("4.7.5", "v4.7.4")).toBe(false);
    expect(isNewerVersion("4.7.5", "4.7.5")).toBe(false);
  });

  it("ignores build/pre-release suffixes and tolerates short tags", () => {
    expect(isNewerVersion("4.7.5", "v4.7.6-android")).toBe(true);
    expect(isNewerVersion("4.7.5", "v4.8")).toBe(true);
    expect(isNewerVersion("4.7.5", "4.8")).toBe(true);
  });

  it("never reports a malformed tag as newer", () => {
    expect(isNewerVersion("4.7.5", "latest")).toBe(false);
    expect(isNewerVersion("4.7.5", "")).toBe(false);
    expect(isNewerVersion("not-a-version", "v9.9.9")).toBe(false);
  });
});

describe("parseVersion", () => {
  it("parses the numeric core and zero-fills missing segments", () => {
    expect(parseVersion("v4.7.6")).toEqual([4, 7, 6]);
    expect(parseVersion("4.8")).toEqual([4, 8, 0]);
    expect(parseVersion("5")).toEqual([5, 0, 0]);
    expect(parseVersion("v4.7.6-rc.1")).toEqual([4, 7, 6]);
  });

  it("returns null when there is no numeric core", () => {
    expect(parseVersion("master")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("updateCheckEnabled", () => {
  it("is on by default and for explicit truthy values", () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ ZCODE_UPDATE_CHECK: "" })).toBe(true);
    expect(updateCheckEnabled({ ZCODE_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckEnabled({ ZCODE_UPDATE_CHECK: "on" })).toBe(true);
  });

  it("is off for every documented off value, case/space insensitive", () => {
    for (const value of ["0", "off", "OFF", " off ", "false", "no", "disabled"]) {
      expect(updateCheckEnabled({ ZCODE_UPDATE_CHECK: value })).toBe(false);
    }
  });
});

describe("isSkippedVersion", () => {
  it("matches muted tags regardless of the v prefix and whitespace", () => {
    expect(isSkippedVersion("v4.7.6", { ZCODE_UPDATE_SKIP: "v4.7.6" })).toBe(true);
    expect(isSkippedVersion("4.7.6", { ZCODE_UPDATE_SKIP: " v4.7.6 , v4.7.7 " })).toBe(true);
    expect(isSkippedVersion("v4.7.6-android", { ZCODE_UPDATE_SKIP: "4.7.6" })).toBe(true);
  });

  it("does not mute anything else", () => {
    expect(isSkippedVersion("v4.7.6", {})).toBe(false);
    expect(isSkippedVersion("v4.7.6", { ZCODE_UPDATE_SKIP: "v4.7.5" })).toBe(false);
    expect(isSkippedVersion("v4.7.6", { ZCODE_UPDATE_SKIP: "   " })).toBe(false);
  });
});

describe("isContainerRuntime", () => {
  it("detects docker and podman markers", () => {
    expect(isContainerRuntime({}, (p) => p === "/.dockerenv")).toBe(true);
    expect(isContainerRuntime({}, (p) => p === "/run/.containerenv")).toBe(true);
    expect(isContainerRuntime({ container: "podman" }, () => false)).toBe(true);
  });

  it("is false on a bare host", () => {
    expect(isContainerRuntime({}, () => false)).toBe(false);
    expect(isContainerRuntime({ container: "   " }, () => false)).toBe(false);
  });
});

describe("buildUpdateNotice", () => {
  const release = { tag: "v4.7.6", url: RELEASE_URL, notes: null };

  it("points Docker users at compose and binaries at the release asset", () => {
    expect(buildUpdateNotice("4.7.5", release, true).text).toContain("docker compose pull && docker compose up -d");
    expect(buildUpdateNotice("4.7.5", release, false).text).toContain(`re-download from ${RELEASE_URL}`);
    expect(buildUpdateNotice("4.7.5", release, false).text).toContain("v4.7.6 is available (you are on v4.7.5)");
  });
});

describe("fetchLatestRelease", () => {
  it("parses tag, url and notes from the releases API", async () => {
    const release = await fetchLatestRelease({ fetchImpl: respondWith(BODY) });
    expect(release).toEqual({ tag: "v4.7.6", url: RELEASE_URL, notes: "release notes" });
  });

  it("sends the User-Agent GitHub requires, plus a timeout signal", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; signal?: AbortSignal } | undefined;
    const probe: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, status: 200, json: async () => BODY };
    };
    await fetchLatestRelease({ fetchImpl: probe });
    expect(seenUrl).toBe(LATEST_RELEASE_API);
    expect(seenInit?.headers?.["User-Agent"]).toBeTruthy();
    expect(seenInit?.headers?.Accept).toBe("application/vnd.github+json");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the releases page when html_url is missing", async () => {
    const release = await fetchLatestRelease({ fetchImpl: respondWith({ tag_name: "v4.7.6" }) });
    expect(release?.url).toBe(`${RELEASES_PAGE}/tag/v4.7.6`);
    expect(release?.notes).toBeNull();
  });

  it("returns null instead of throwing for every failure mode", async () => {
    expect(await fetchLatestRelease({ fetchImpl: rejecting() })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith(BODY, 403) })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith(BODY, 404) })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith(BODY, 500) })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith(null) })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith({ tag_name: "" }) })).toBeNull();
    expect(await fetchLatestRelease({ fetchImpl: respondWith({ tag_name: 42 }) })).toBeNull();
    const badJson: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    expect(await fetchLatestRelease({ fetchImpl: badJson })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("reports an update with the container-aware command", async () => {
    const result = await checkForUpdate("4.7.5", {
      fetchImpl: respondWith(BODY),
      env: {},
      isContainer: true,
    });
    expect(result.kind).toBe("update");
    if (result.kind !== "update") return;
    expect(result.notice.latest).toBe("v4.7.6");
    expect(result.notice.text).toContain("docker compose pull && docker compose up -d");
  });

  it("uses the download hint outside a container", async () => {
    const result = await checkForUpdate("4.7.5", { fetchImpl: respondWith(BODY), env: {}, isContainer: false });
    expect(result.kind).toBe("update");
    if (result.kind !== "update") return;
    expect(result.notice.text).toContain(RELEASE_URL);
  });

  it("is up-to-date for equal and older releases", async () => {
    expect((await checkForUpdate("4.7.6", { fetchImpl: respondWith(BODY), env: {} })).kind).toBe("up-to-date");
    expect((await checkForUpdate("4.8.0", { fetchImpl: respondWith(BODY), env: {} })).kind).toBe("up-to-date");
  });

  it("skips disabled checks without even calling the network", async () => {
    let calls = 0;
    const counting: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => BODY };
    };
    const result = await checkForUpdate("4.7.5", { fetchImpl: counting, env: { ZCODE_UPDATE_CHECK: "off" } });
    expect(result.kind).toBe("unavailable");
    expect(calls).toBe(0);
  });

  it("honours the skip list, and a manual check overrides it", async () => {
    const env = { ZCODE_UPDATE_SKIP: "v4.7.6" };
    expect((await checkForUpdate("4.7.5", { fetchImpl: respondWith(BODY), env })).kind).toBe("skipped");
    expect((await checkForUpdate("4.7.5", { fetchImpl: respondWith(BODY), env, force: true })).kind).toBe("update");
    // A manual check is also allowed while the automatic one is disabled.
    const off = { ZCODE_UPDATE_CHECK: "off" };
    expect((await checkForUpdate("4.7.5", { fetchImpl: respondWith(BODY), env: off, force: true })).kind).toBe("update");
  });

  it("reports unavailable when the network fails, never throwing", async () => {
    const result = await checkForUpdate("4.7.5", { fetchImpl: rejecting(), env: {} });
    expect(result.kind).toBe("unavailable");
  });
});
