/**
 * installer.ts — Analyse an in-memory skill tree and determine what to install.
 *
 * Responsibilities:
 *   - Detect `.claude-plugin/marketplace.json` (Anthropic Plugin Marketplace format)
 *   - Detect skill roots (directories containing `SKILL.md`)
 *   - Apply subPath / skillName hints from the resolver
 *   - Produce a preview (for ambiguous installs) OR a concrete plan (for unambiguous ones)
 *
 * Does NOT write to disk — caller is responsible for using the existing
 * zip-slip-protected write path in `/api/skill/upload`.
 */

import { load as yamlLoad } from 'js-yaml';
import { parseFullSkillContent } from '../../shared/slashCommands';
import type { ExtractedTree } from './tarball-fetcher';
import type { ResolvedSkillSource } from './url-resolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single skill candidate discovered inside the tree */
export interface SkillCandidate {
  /** Path inside the tree where SKILL.md lives (the skill root). '' means tree root. */
  rootPath: string;
  /** Preferred folder name (from frontmatter.name or basename). Sanitization is caller's job. */
  suggestedFolderName: string;
  /** Parsed skill name (from frontmatter) */
  name: string;
  /** Parsed description */
  description: string;
  /** True when frontmatter's `allowed-tools` mentions Bash/Shell etc — surface as a warning */
  hasDangerousTools: boolean;
}

/** A Claude Plugins plugin group parsed from marketplace.json */
export interface PluginGroup {
  /** Plugin name as it appears in marketplace.json */
  name: string;
  /** Plugin description */
  description: string;
  /** Skill root paths this plugin contributes (pre-resolved against plugin `source`) */
  skills: SkillCandidate[];
}

/** Result of analysing a fetched tree */
export type InstallAnalysis =
  | {
      mode: 'single';
      skill: SkillCandidate;
    }
  | {
      mode: 'multi';
      candidates: SkillCandidate[];
    }
  | {
      mode: 'marketplace';
      marketplaceName: string;
      marketplaceDescription?: string;
      plugins: PluginGroup[];
    }
  | {
      mode: 'empty';
      reason: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyseTree(tree: ExtractedTree, src: ResolvedSkillSource): InstallAnalysis {
  // 1. Marketplace takes precedence (only when user didn't specify subPath/skillName)
  if (!src.subPath && !src.skillName) {
    const marketplace = tryParseMarketplace(tree);
    if (marketplace) return marketplace;
  }

  // 2. Collect all SKILL.md locations in the tree
  const allSkills = scanForSkills(tree);
  if (allSkills.length === 0) {
    return { mode: 'empty', reason: '未找到 SKILL.md — 仓库不是有效的 skill' };
  }

  // 3. Apply subPath hint — only keep skills under that prefix
  let filtered = allSkills;
  if (src.subPath) {
    const prefix = src.subPath.replace(/\/+$/, '') + '/';
    filtered = allSkills.filter(
      s => s.rootPath === src.subPath || s.rootPath.startsWith(prefix),
    );
    if (filtered.length === 0) {
      return { mode: 'empty', reason: `子路径 "${src.subPath}" 下未找到 SKILL.md` };
    }
  }

  // 4. Apply skillName hint — exact match on frontmatter.name or folder name
  if (src.skillName) {
    const hint = src.skillName.toLowerCase();
    const exact = filtered.filter(
      s => s.name.toLowerCase() === hint || s.suggestedFolderName.toLowerCase() === hint,
    );
    if (exact.length > 0) {
      filtered = exact;
    } else {
      return { mode: 'empty', reason: `未找到名为 "${src.skillName}" 的 skill` };
    }
  }

  if (filtered.length === 1) {
    return { mode: 'single', skill: filtered[0] };
  }
  return { mode: 'multi', candidates: filtered };
}

/**
 * Given a plan (skill candidates to install) + the tree, build a map of
 * `{targetFolderName → Map<relativeInsideFolder, Buffer>}` ready to be
 * written to disk.
 */
export function buildInstallPayload(
  tree: ExtractedTree,
  candidates: SkillCandidate[],
): Map<string, Map<string, Buffer>> {
  const result = new Map<string, Map<string, Buffer>>();
  for (const cand of candidates) {
    const prefix = cand.rootPath === '' ? '' : `${cand.rootPath.replace(/\/+$/, '')}/`;
    const folderFiles = new Map<string, Buffer>();
    for (const [path, buf] of tree.files) {
      if (prefix === '' || path.startsWith(prefix)) {
        const rel = prefix === '' ? path : path.slice(prefix.length);
        if (!rel) continue;
        folderFiles.set(rel, buf);
      }
    }
    if (folderFiles.size > 0) {
      result.set(cand.suggestedFolderName, folderFiles);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal scanning
// ---------------------------------------------------------------------------

/** Walk the tree to find every SKILL.md */
function scanForSkills(tree: ExtractedTree): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];
  for (const [relPath, buf] of tree.files) {
    if (!relPath.toLowerCase().endsWith('skill.md')) continue;
    if (relPath.toLowerCase().endsWith('/skill.md') || relPath.toLowerCase() === 'skill.md') {
      // ok
    } else {
      continue;
    }
    const rootPath = relPath.toLowerCase() === 'skill.md'
      ? ''
      : relPath.slice(0, relPath.length - '/SKILL.md'.length);

    const cand = buildCandidate(rootPath, buf.toString('utf-8'));
    if (cand) candidates.push(cand);
  }
  // Sort by rootPath depth so shallower skills come first (stable UI)
  candidates.sort((a, b) => {
    const da = a.rootPath.split('/').length;
    const db = b.rootPath.split('/').length;
    if (da !== db) return da - db;
    return a.rootPath.localeCompare(b.rootPath);
  });
  return candidates;
}

function buildCandidate(rootPath: string, content: string): SkillCandidate | null {
  let name = '';
  let description = '';
  let allowedTools: string[] = [];
  try {
    // parseFullSkillContent is strict (string-only allowed-tools). We re-parse
    // the raw frontmatter block here because the Agent Skills spec permits
    // allowed-tools as an array — and we specifically need to surface array
    // form to the UI as a "dangerous tools" warning.
    const parsed = parseFullSkillContent(content);
    name = (parsed.frontmatter?.name as string) || '';
    description = (parsed.frontmatter?.description as string) || '';

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const raw = yamlLoad(fmMatch[1]) as Record<string, unknown> | null;
      const tools = raw?.['allowed-tools'];
      if (Array.isArray(tools)) {
        allowedTools = tools.filter((x): x is string => typeof x === 'string');
      } else if (typeof tools === 'string') {
        allowedTools = tools.split(/[,\s]+/).filter(Boolean);
      }
    }
  } catch {
    // Fall through — we'll use defaults below
  }

  // Suggested folder name: frontmatter.name wins, then the last path segment
  const basename = rootPath === '' ? '' : rootPath.split('/').pop() ?? '';
  const suggestedFolderName = name || basename || 'unnamed-skill';
  if (!suggestedFolderName) return null;

  return {
    rootPath,
    suggestedFolderName,
    name: name || suggestedFolderName,
    description,
    hasDangerousTools: allowedTools.some(t => /^(bash|shell|exec|run)/i.test(t)),
  };
}

// ---------------------------------------------------------------------------
// Marketplace.json parsing
// ---------------------------------------------------------------------------

interface MarketplaceJson {
  name?: string;
  metadata?: { description?: string; version?: string };
  plugins?: Array<{
    name?: string;
    description?: string;
    source?: string;
    skills?: string[];
  }>;
}

function tryParseMarketplace(tree: ExtractedTree): InstallAnalysis | null {
  const mpBuf = tree.files.get('.claude-plugin/marketplace.json');
  if (!mpBuf) return null;

  let parsed: MarketplaceJson;
  try {
    parsed = JSON.parse(mpBuf.toString('utf-8')) as MarketplaceJson;
  } catch {
    return null;
  }

  if (!parsed.plugins || !Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
    return null;
  }

  const plugins: PluginGroup[] = [];
  for (const p of parsed.plugins) {
    if (!p.name || !Array.isArray(p.skills)) continue;
    const sourceRoot = (p.source ?? './').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const skillCandidates: SkillCandidate[] = [];

    for (const skillRel of p.skills) {
      const rel = skillRel.replace(/^\.\/+/, '').replace(/\/+$/, '');
      const rootPath = sourceRoot ? `${sourceRoot}/${rel}` : rel;
      const skillMdPath = `${rootPath}/SKILL.md`;
      const buf = tree.files.get(skillMdPath);
      if (!buf) continue;
      const cand = buildCandidate(rootPath, buf.toString('utf-8'));
      if (cand) skillCandidates.push(cand);
    }

    if (skillCandidates.length > 0) {
      plugins.push({
        name: p.name,
        description: p.description || '',
        skills: skillCandidates,
      });
    }
  }

  if (plugins.length === 0) return null;

  return {
    mode: 'marketplace',
    marketplaceName: parsed.name || 'claude-plugins',
    marketplaceDescription: parsed.metadata?.description,
    plugins,
  };
}
