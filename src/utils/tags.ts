/**
 * Smart Volume Radar - Newlogic Tags
 * Replaces Setup (Full/Close) with independent tags.
 */

import type { StockData } from '../types/index.js';

const ALL_THREE_TAGS: readonly ['SMA21 Touch', 'Pullback 15%', '1M Breakout'] = [
    'SMA21 Touch',
    'Pullback 15%',
    '1M Breakout',
];

/** True if stock has all three Newlogic tags (blue entry path) */
export function hasAllThreeTags(s: StockData): boolean {
    const tags = s.tags ?? [];
    return ALL_THREE_TAGS.every((t) => tags.includes(t));
}

/** Get tag count for sorting (more tags = higher priority) */
export function getTagCount(s: StockData): number {
    return s.tags?.length ?? 0;
}

/** Format tags for display, e.g. "SMA21 Touch • Pullback 15%" */
export function formatTagsForDisplay(s: StockData): string {
    const tags = s.tags ?? [];
    if (tags.length === 0) return '';
    return tags.join(' • ');
}
