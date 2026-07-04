import React from 'react';
import { View, Pressable, FlatList, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { type SessionState, formatLastSeen } from '@/utils/sessionUtils';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

// ─── Agent avatar config ──────────────────────────────────────────────────────

type AgentVariant = 'claude' | 'gemini' | 'apichat' | 'codex' | 'openclaw' | 'default';

const AGENT_CFG: Record<AgentVariant, { letter: string; bg: string; fg: string }> = {
    claude:   { letter: 'C',  bg: '#ede9fe', fg: '#5b21b6' },
    gemini:   { letter: 'G',  bg: '#dbeafe', fg: '#1d4ed8' },
    apichat:  { letter: 'A',  bg: '#fef3c7', fg: '#92400e' },
    codex:    { letter: 'Co', bg: '#dcfce7', fg: '#15803d' },
    openclaw: { letter: 'O',  bg: '#fce7f3', fg: '#9d174d' },
    default:  { letter: '·',  bg: '#f1f5f9', fg: '#64748b' },
};

function resolveAgentVariant(flavor: string | null): AgentVariant {
    if (!flavor) return 'default';
    if (flavor === 'claude') return 'claude';
    if (flavor === 'gemini') return 'gemini';
    if (flavor === 'apichat') return 'apichat';
    if (flavor === 'gpt' || flavor === 'openai' || flavor === 'codex') return 'codex';
    if (flavor === 'openclaw') return 'openclaw';
    return 'default';
}

// ─── Status config ────────────────────────────────────────────────────────────

type StatusVariant = 'needs-you' | 'working' | 'waiting' | 'offline';

const STATUS_CFG: Record<StatusVariant, { label: string; dot: string }> = {
    'needs-you': { label: '待审批', dot: '#f59e0b' },
    'working':   { label: '工作中', dot: '#3b82f6' },
    'waiting':   { label: '在线',   dot: '#22c55e' },
    'offline':   { label: '离线',   dot: '#cbd5e1' },
};

function resolveStatusVariant(state: SessionState, hasUnread: boolean): StatusVariant {
    if (hasUnread || state === 'permission_required') return 'needs-you';
    if (state === 'thinking') return 'working';
    if (state === 'waiting') return 'waiting';
    return 'offline';
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },

    // Section header — subtle, minimal
    sectionHeader: {
        paddingHorizontal: 18,
        paddingTop: 18,
        paddingBottom: 4,
    },
    sectionHeaderText: {
        fontSize: 11,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },

    // Row outer — clip accent bar to rounded corners
    rowOuter: {
        flexDirection: 'row' as const,
        alignItems: 'stretch' as const,
        marginHorizontal: 8,
        marginBottom: 0,
        borderRadius: 10,
        overflow: 'hidden' as const,
    },

    // Accent bar — amber left edge for "needs you" items
    accentBar: {
        width: 3,
        backgroundColor: '#f59e0b',
        flexShrink: 0,
    },

    // Row — pressable content
    row: {
        flex: 1,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 10,
        paddingVertical: 6,
        gap: 10,
    },
    rowOffline: {
        opacity: 0.5,
    },
    rowNeedsYouBg: {
        backgroundColor: 'rgba(245, 158, 11, 0.05)',
    },
    rowPressed: {
        backgroundColor: theme.colors.surface,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface,
    },

    // Agent avatar — 32×32 circle
    avatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        flexShrink: 0,
    },
    avatarText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
    },

    // Content column
    content: {
        flex: 1,
        gap: 2,
    },

    // Title row
    titleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
    },
    title: {
        fontSize: 14,
        flex: 1,
        color: theme.colors.text,
        lineHeight: 19,
        ...Typography.default('semiBold'),
    },
    titleOffline: {
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    unreadDot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
        backgroundColor: '#3b82f6',
        flexShrink: 0,
    },

    // Meta row — status dot + label + time
    metaRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 5,
    },
    statusDot: {
        width: 5,
        height: 5,
        borderRadius: 2.5,
        flexShrink: 0,
    },
    metaText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    metaTime: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 'auto' as any,
        ...Typography.default(),
    },

    // Permission preview — tools awaiting approval
    permissionPreview: {
        fontSize: 11,
        color: '#b45309',
        marginTop: 1,
        ...Typography.default(),
    },

    // Archive toggle
    archiveToggle: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 20,
        paddingVertical: 14,
    },
    archiveToggleLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.groupped.sectionTitle,
        opacity: 0.2,
    },
    archiveToggleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 10,
        opacity: 0.6,
        ...Typography.default('semiBold'),
    },
}));

// ─── AgentAvatar ──────────────────────────────────────────────────────────────

const AgentAvatar = React.memo(({ flavor }: { flavor: string | null }) => {
    const cfg = AGENT_CFG[resolveAgentVariant(flavor)];
    return (
        <View style={[stylesheet.avatar, { backgroundColor: cfg.bg }]}>
            <Text style={[stylesheet.avatarText, { color: cfg.fg }]}>{cfg.letter}</Text>
        </View>
    );
});

// ─── SessionItem ──────────────────────────────────────────────────────────────

const SessionItem = React.memo(({ session, selected }: {
    session: SessionRowData;
    selected?: boolean;
}) => {
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const showActionAlert = useSessionActionAlert(session.id);

    const statusVariant = resolveStatusVariant(session.state, session.hasUnread);
    const isNeedsYou = statusVariant === 'needs-you';
    const isOffline = session.state === 'disconnected';
    const statusCfg = STATUS_CFG[statusVariant];

    const statusLabel = React.useMemo<string>(() => {
        if (session.hasUnread) return t('status.unread');
        return statusCfg.label;
    }, [session.hasUnread, statusVariant]);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const menuProps = Platform.OS === 'web'
        ? { onContextMenu: handleContextMenu } as any
        : { onLongPress: showActionAlert };

    return (
        <View style={styles.rowOuter}>
            {/* Amber accent bar — only for "needs you" */}
            {isNeedsYou && <View style={styles.accentBar} />}

            <Pressable
                onPress={handlePress}
                {...menuProps}
                style={({ pressed }) => [
                    styles.row,
                    isOffline && styles.rowOffline,
                    isNeedsYou && styles.rowNeedsYouBg,
                    pressed && styles.rowPressed,
                    selected && styles.rowSelected,
                ]}
            >
                <AgentAvatar flavor={session.flavor} />

                <View style={styles.content}>
                    {/* Title + unread dot */}
                    <View style={styles.titleRow}>
                        <Text
                            style={[styles.title, isOffline && styles.titleOffline]}
                            numberOfLines={1}
                        >
                            {session.name}
                        </Text>
                        {session.hasUnread && <View style={styles.unreadDot} />}
                    </View>

                    {/* Status dot + label + last-seen time */}
                    <View style={styles.metaRow}>
                        <View style={[styles.statusDot, { backgroundColor: statusCfg.dot }]} />
                        <Text style={styles.metaText}>{statusLabel}</Text>
                        {isOffline && session.activeAt && (
                            <Text style={styles.metaTime}>
                                {formatLastSeen(session.activeAt, false)}
                            </Text>
                        )}
                    </View>

                    {/* Tools waiting for approval */}
                    {session.permissionPreview && (
                        <Text style={styles.permissionPreview} numberOfLines={1}>
                            ⚠ {session.permissionPreview}
                        </Text>
                    )}
                </View>
            </Pressable>

            {Platform.OS === 'web' && (
                <SessionActionsPopover
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                    anchor={actionsAnchor ?? { type: 'point', x: 0, y: 0 }}
                    onClose={() => setActionsAnchor(null)}
                />
            )}
        </View>
    );
});

// ─── SessionsList ─────────────────────────────────────────────────────────────

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');

    const toggleArchived = React.useCallback(() => {
        setHideInactiveSessions(!hideInactiveSessions);
    }, [hideInactiveSessions, setHideInactiveSessions]);

    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    React.useEffect(() => {
        if (data && data.length > 0) requestReview();
    }, [data && data.length > 0]);

    if (!data) return <View style={styles.container} />;

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header':          return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'archive-toggle':  return 'archive-toggle';
            case 'project-group':   return `project-group-${index}`;
            case 'session':         return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionHeaderText}>{item.title}</Text>
                    </View>
                );

            case 'archive-toggle':
                return (
                    <Pressable style={styles.archiveToggle} onPress={toggleArchived}>
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );

            // Legacy types — not emitted by new grouping
            case 'active-sessions':
            case 'project-group':
                return null;

            case 'session':
                return (
                    <SessionItem
                        session={item.session}
                        selected={item.session.id === selectedSessionId}
                    />
                );
        }
    }, [selectedSessionId, toggleArchived]);

    const HeaderComponent = React.useCallback(() => <UpdateBanner />, []);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={selectedSessionId}
                    contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                    ListHeaderComponent={HeaderComponent}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                />
            </View>
        </View>
    );
}
