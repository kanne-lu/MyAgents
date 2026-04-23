// useThoughtTagCandidates — merge thought-history tags with Agent workspace
// names to feed the `#` autocomplete picker in ThoughtInput.
//
// Why this exists: users naturally want to tag a thought with a workspace
// ("#今天在工作区 X 想到的…"), so the picker should expose workspace names as
// *default* candidates — visible even when no thought has used that tag yet.
// Previously the picker only knew history tags (aggregated from existing
// thoughts), so a brand-new workspace was invisible until you'd typed its
// `#` tag at least once elsewhere.
//
// Output shape matches `ThoughtInput.existingTags` verbatim
// (`Array<[tag, count]>`, sorted desc by count): history tags keep their real
// frequency; workspace-name entries get a virtual count of `0` so they sort
// to the bottom without interfering with the frequency ordering of real tags.
// This `count=0` sentinel is part of the ThoughtInput <-> this hook contract
// (see `ThoughtInput.existingTags` JSDoc) — do NOT filter it out in
// consumers.
//
// Contrast with `ThoughtPanel.allTags`: that variant is history-only
// because it drives the search drawer's tag cloud, where phantom agent
// tags would filter into empty result sets. `tagCandidates` is the
// *picker superset* (history + discovery); `allTags` is the *filter
// inventory* (history only). Keep the two distinct.
//
// Agent names go through `sanitizeForTag` (shared with the Rust parser
// mirror in `parseThoughtTags.ts`) so inserted `#<name>` round-trips
// through `parse_tags` cleanly — spaces, CJK punct, emoji all coerced to
// `_`; empty results dropped. Case-insensitive dedup against history
// tags so typing `#work` in one place and creating a workspace named
// `Work` don't silently fork the tag namespace (the ThoughtPanel tag
// filter is case-sensitive — `#work` and `#Work` would otherwise mean
// two distinct buckets).

import { useMemo } from 'react';
import type { Thought } from '@/../shared/types/thought';
import type { AgentConfig } from '@/../shared/types/agent';
import { sanitizeForTag } from '@/utils/parseThoughtTags';

/**
 * Build the `#` autocomplete candidate list for ThoughtInput.
 *
 * Pass `agents` as `null`/`undefined` when you only want history tags
 * (e.g. a consumer that doesn't have workspace context).
 */
export function useThoughtTagCandidates(
  thoughts: readonly Thought[] | null | undefined,
  agents: readonly AgentConfig[] | null | undefined,
): Array<[string, number]> {
  // Collapse `agents` down to a stable name array — this is the ONLY
  // thing the merge actually consumes. `config.agents` is a fresh array
  // reference on every `loadAppConfig()` (e.g. SSE config:changed events
  // fire on IM Bot / Cron / CLI writes) even when the names haven't
  // changed, and without this layer the outer useMemo would re-sort and
  // re-allocate on every such event. With it, the outer useMemo only
  // runs when an actual name changed.
  const agentNames = useMemo(() => {
    if (!agents) return '';
    return agents
      .map((a) => a.name?.trim() ?? '')
      .filter(Boolean)
      .sort()
      .join('\n');
  }, [agents]);

  return useMemo(() => {
    const counts = new Map<string, number>();
    // Case-insensitive dedup key → canonical stored form. History wins
    // over agent-derived entries for two reasons: (1) history carries
    // the real count; (2) history preserves the user's exact casing
    // (Rust tag store is case-preserving), so surfacing the agent's
    // casing on top would split filter results downstream.
    const lowerToCanonical = new Map<string, string>();

    if (thoughts) {
      for (const t of thoughts) {
        for (const tag of t.tags) {
          const key = tag.toLowerCase();
          const canonical = lowerToCanonical.get(key) ?? tag;
          lowerToCanonical.set(key, canonical);
          counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
        }
      }
    }

    if (agentNames) {
      for (const raw of agentNames.split('\n')) {
        if (!raw) continue;
        const safe = sanitizeForTag(raw);
        if (!safe) continue;
        const key = safe.toLowerCase();
        // Skip agent names whose normalized form already exists as a
        // history tag (any casing). Prevents `#work` (history) and
        // `#Work` (agent) appearing as two rows that filter into
        // different buckets.
        if (lowerToCanonical.has(key)) continue;
        lowerToCanonical.set(key, safe);
        counts.set(safe, 0);
      }
    }

    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [thoughts, agentNames]);
}

export default useThoughtTagCandidates;
