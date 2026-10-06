import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUpgradeCommand,
  resolveReleaseTarball,
  resolveUpgradeTag,
  upgrade,
} from "../../src/commands/upgrade.js";

const TARBALL_URL =
  "https://github.com/ScoFan-official/trellis/releases/download/v0.6.17-ohmy.2/oh-my-trellis-0.6.17-ohmy.2.tgz";

/** Stub fetch to answer the GitHub releases API. */
function stubReleaseFetch(tagName = "v0.6.17-ohmy.2", withTgz = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("api.github.com")) {
        return new Response("", { status: 404 });
      }
      const release = {
        tag_name: tagName,
        assets: withTgz
          ? [
              { name: "source.zip", browser_download_url: "https://x/z" },
              { name: "oh-my-trellis.tgz", browser_download_url: TARBALL_URL },
            ]
          : [{ name: "source.zip", browser_download_url: "https://x/z" }],
      };
      return new Response(JSON.stringify(release), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upgrade command", () => {
  it("defaults to the latest GitHub release", () => {
    expect(resolveUpgradeTag()).toBe("latest");
    expect(resolveUpgradeTag(undefined)).toBe("latest");
    expect(resolveUpgradeTag("latest")).toBe("latest");
  });

  it("honors an explicit release tag or version", () => {
    expect(resolveUpgradeTag("v0.6.17-ohmy.1")).toBe("v0.6.17-ohmy.1");
    expect(resolveUpgradeTag("0.6.17-ohmy.2")).toBe("0.6.17-ohmy.2");
  });

  it("rejects shell-shaped tags", () => {
    expect(() => resolveUpgradeTag("latest && rm -rf /")).toThrow(
      /Invalid release tag\/version/,
    );
  });

  it("resolves the .tgz asset of the latest release", async () => {
    stubReleaseFetch();
    const release = await resolveReleaseTarball("latest");
    expect(release.tarballUrl).toBe(TARBALL_URL);
    expect(release.tagName).toBe("v0.6.17-ohmy.2");
  });

  it("fails when the release has no tarball asset", async () => {
    stubReleaseFetch("v9.9.9", false);
    await expect(resolveReleaseTarball("latest")).rejects.toThrow(
      /no \.tgz asset/,
    );
  });

  it("builds POSIX npm global install command without shell", () => {
    expect(
      buildUpgradeCommand(TARBALL_URL, "v0.6.17-ohmy.2", "darwin"),
    ).toMatchObject({
      command: "npm",
      args: ["install", "-g", TARBALL_URL],
      spawnOptions: { stdio: "inherit", shell: false },
      displayCommand: `npm install -g ${TARBALL_URL}`,
      target: TARBALL_URL,
      tag: "v0.6.17-ohmy.2",
      binaryCheckCommand: "which trellis",
    });
  });

  it("builds Windows command through cmd.exe", () => {
    expect(
      buildUpgradeCommand(TARBALL_URL, "v0.6.17-ohmy.2", "win32"),
    ).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `npm install -g ${TARBALL_URL}`],
      spawnOptions: { stdio: "inherit", shell: false },
      displayCommand: `npm install -g ${TARBALL_URL}`,
      target: TARBALL_URL,
      tag: "v0.6.17-ohmy.2",
      binaryCheckCommand: "where trellis",
    });
  });

  it("dry-run does not execute npm", async () => {
    stubReleaseFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn();

    await upgrade({ dryRun: true, tag: "latest" }, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`Run: npm install -g ${TARBALL_URL}`),
    );

    log.mockRestore();
  });

  it("executes npm install of the release tarball for real upgrades", async () => {
    stubReleaseFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn(() => ({ status: 0, signal: null }));

    await upgrade({ tag: "latest" }, runner);

    const isWindows = process.platform === "win32";
    expect(runner).toHaveBeenCalledWith(
      isWindows ? "cmd.exe" : "npm",
      isWindows
        ? ["/d", "/s", "/c", `npm install -g ${TARBALL_URL}`]
        : ["install", "-g", TARBALL_URL],
      { stdio: "inherit", shell: false },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("trellis --version"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(isWindows ? "where trellis" : "which trellis"),
    );

    log.mockRestore();
  });

  it("fails when npm exits non-zero", async () => {
    stubReleaseFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn(() => ({ status: 1, signal: null }));

    await expect(upgrade({ tag: "latest" }, runner)).rejects.toThrow(
      /npm install failed with exit code 1/,
    );

    log.mockRestore();
  });
});
