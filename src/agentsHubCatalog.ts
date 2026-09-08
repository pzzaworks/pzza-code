export interface SkillCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceUrl: string;
  readonly subpath: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly stars: number | null;
  readonly checkedAt: string;
}

// Repository stars are a dated popularity snapshot, not a skill quality rating.
// Source folders can include scripts, references, assets, and external prerequisites.
export const SKILL_CATALOG: readonly SkillCatalogEntry[] = [
  {
    "id": "frontend-design",
    "name": "Frontend design",
    "description": "Shape distinctive interfaces through typography, layout, color, and visual direction.",
    "sourceUrl": "https://github.com/anthropics/skills",
    "subpath": "skills/frontend-design",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/anthropics/skills/blob/main/skills/frontend-design/LICENSE.txt",
    "stars": 175178,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "playwright",
    "name": "Playwright browser automation",
    "description": "Navigate real browsers, capture screenshots, and inspect UI flows with a bundled CLI wrapper.",
    "sourceUrl": "https://github.com/openai/skills",
    "subpath": "skills/.curated/playwright",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/openai/skills/blob/main/skills/.curated/playwright/LICENSE.txt",
    "stars": 26340,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "react-best-practices",
    "name": "React performance",
    "description": "Review React and Next.js rendering, data fetching, bundle size, and performance patterns.",
    "sourceUrl": "https://github.com/vercel-labs/agent-skills",
    "subpath": "skills/react-best-practices",
    "license": "MIT",
    "licenseUrl": "https://github.com/vercel-labs/agent-skills/blob/main/README.md#license",
    "stars": 30967,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "systematic-debugging",
    "name": "Systematic debugging",
    "description": "Trace root causes and gather evidence before changing code to fix a bug.",
    "sourceUrl": "https://github.com/obra/superpowers",
    "subpath": "skills/systematic-debugging",
    "license": "MIT",
    "licenseUrl": "https://github.com/obra/superpowers/blob/main/LICENSE",
    "stars": 283142,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "test-driven-development",
    "name": "Test-driven development",
    "description": "Work through failing tests, focused implementation, and refactoring in small steps.",
    "sourceUrl": "https://github.com/obra/superpowers",
    "subpath": "skills/test-driven-development",
    "license": "MIT",
    "licenseUrl": "https://github.com/obra/superpowers/blob/main/LICENSE",
    "stars": 283142,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "semgrep",
    "name": "Semgrep security scanning",
    "description": "Plan security scans, select rules, and combine findings into SARIF reports.",
    "sourceUrl": "https://github.com/trailofbits/skills",
    "subpath": "plugins/static-analysis/skills/semgrep",
    "license": "CC-BY-SA-4.0",
    "licenseUrl": "https://github.com/trailofbits/skills/blob/main/LICENSE",
    "stars": 7018,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "expo-ui",
    "name": "Expo native UI",
    "description": "Build native interface components with Expo UI for iOS and Android.",
    "sourceUrl": "https://github.com/expo/skills",
    "subpath": "plugins/expo/skills/expo-ui",
    "license": "MIT",
    "licenseUrl": "https://github.com/expo/skills/blob/main/plugins/expo/LICENSE",
    "stars": 2508,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "postgres-best-practices",
    "name": "Postgres best practices",
    "description": "Review schema design, SQL, migrations, row security, and database performance.",
    "sourceUrl": "https://github.com/supabase/agent-skills",
    "subpath": "skills/supabase-postgres-best-practices",
    "license": "MIT",
    "licenseUrl": "https://github.com/supabase/agent-skills/blob/main/LICENSE",
    "stars": 2584,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "huggingface-datasets",
    "name": "Dataset exploration",
    "description": "Inspect dataset splits, search and filter rows, and retrieve statistics with the Dataset Viewer API.",
    "sourceUrl": "https://github.com/huggingface/skills",
    "subpath": "skills/huggingface-datasets",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/huggingface/skills/blob/main/LICENSE",
    "stars": 11025,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "azure-identity-ts",
    "name": "Azure Identity for TypeScript",
    "description": "Configure credentials, managed identities, and authentication with the JavaScript Identity SDK.",
    "sourceUrl": "https://github.com/microsoft/skills",
    "subpath": ".github/plugins/azure-sdk-typescript/skills/azure-identity-ts",
    "license": "MIT",
    "licenseUrl": "https://github.com/microsoft/skills/blob/main/LICENSE",
    "stars": 2999,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "code-review",
    "name": "Sentry code review",
    "description": "Review changes for security, performance, testing, and maintainability using Sentry engineering guidance.",
    "sourceUrl": "https://github.com/getsentry/skills",
    "subpath": "skills/code-review",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/getsentry/skills/blob/main/LICENSE",
    "stars": 985,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "web-perf",
    "name": "Web performance audit",
    "description": "Investigate loading speed, interaction responsiveness, Core Web Vitals, and Lighthouse findings.",
    "sourceUrl": "https://github.com/cloudflare/skills",
    "subpath": "skills/web-perf",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/cloudflare/skills/blob/main/LICENSE",
    "stars": 2800,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "vitest",
    "name": "Vitest testing",
    "description": "Write tests, mocks, coverage settings, and test fixtures for Vite projects.",
    "sourceUrl": "https://github.com/antfu/skills",
    "subpath": "skills/vitest",
    "license": "MIT",
    "licenseUrl": "https://github.com/antfu/skills/blob/main/LICENSE.md",
    "stars": 5863,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "scientific-writing",
    "name": "Scientific writing",
    "description": "Draft and audit research writing with source provenance, reporting guidelines, and consistency checks.",
    "sourceUrl": "https://github.com/K-Dense-AI/scientific-agent-skills",
    "subpath": "skills/scientific-writing",
    "license": "MIT",
    "licenseUrl": "https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/LICENSE.md",
    "stars": 43807,
    "checkedAt": "2026-09-08"
  },
  {
    "id": "changelog-generator",
    "name": "Changelog generation",
    "description": "Turn commit history into categorized release notes written for users.",
    "sourceUrl": "https://github.com/ComposioHQ/awesome-claude-skills",
    "subpath": "changelog-generator",
    "license": "Apache-2.0",
    "licenseUrl": "https://github.com/ComposioHQ/awesome-claude-skills/blob/master/README.md#license",
    "stars": 74672,
    "checkedAt": "2026-09-08"
  }
];
