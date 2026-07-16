import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

describe("open-source repository configuration", () => {
  it("publishes the expected community health files and ownership policy", () => {
    expect(read(".github/CODEOWNERS")).toContain("* @damienbenveniste");
    expect(read("CONTRIBUTING.md")).toContain("Fork the repository");
    expect(read("GOVERNANCE.md")).toContain("sole maintainer");
    expect(read(".github/dependabot.yml")).toContain("package-ecosystem: pip");
    expect(read(".github/PULL_REQUEST_TEMPLATE.md")).toContain(
      "Manual Publishing Boundary",
    );
    expect(read("SECURITY.md")).toContain("security/advisories/new");
    expect(read("LICENSE")).toContain(
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    );
  });

  it("keeps the Pages deployment reproducible and least-privileged", () => {
    const workflow = read(".github/workflows/pages.yml");

    for (const marker of [
      "permissions:",
      "contents: read",
      "pages: write",
      "id-token: write",
      "persist-credentials: false",
      "uv pip sync --python .venv/bin/python --require-hashes docs/requirements.lock",
      ".venv/bin/mkdocs build --strict",
      "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d",
      "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
      "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
    ]) {
      expect(workflow).toContain(marker);
    }
  });

  it("declares public package and documentation metadata", () => {
    const manifest = JSON.parse(read("package.json")) as {
      license?: string;
      homepage?: string;
      repository?: { url?: string };
    };

    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.homepage).toBe(
      "https://damienbenveniste.github.io/substack-mcp/",
    );
    expect(manifest.repository?.url).toBe(
      "git+https://github.com/damienbenveniste/substack-mcp.git",
    );
    expect(read("mkdocs.yml")).toContain(
      "site_url: https://damienbenveniste.github.io/substack-mcp/",
    );
    expect(read("docs/requirements.in")).toBe(
      "mkdocs==1.6.1\nmkdocs-material==9.7.6\n",
    );
  });
});
