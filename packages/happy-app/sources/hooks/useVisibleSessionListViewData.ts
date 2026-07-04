import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';

/**
 * Applies the user's "hide inactive sessions" preference to the raw list data.
 *
 * buildSessionListViewData produces a flat list already grouped by work status
 * (needs-you → working → waiting → done-today → archive-toggle → older).
 * This hook just:
 *   1. Overwrites archive-toggle.hidden with the live setting value.
 *   2. Strips the session items that follow the archive-toggle when hiding is on.
 */
export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) return data;

        const result: SessionListViewItem[] = [];
        let afterToggle = false;

        for (const item of data) {
            if (item.type === 'archive-toggle') {
                afterToggle = true;
                result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
                continue;
            }

            // Suppress older sessions when hiding is active
            if (afterToggle && hideInactiveSessions) {
                continue;
            }

            result.push(item);
        }

        return result;
    }, [data, hideInactiveSessions]);
}
