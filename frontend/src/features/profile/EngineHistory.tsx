import { Text, View } from 'react-native';

import { useNow } from '@/hooks/useNow';
import { useGameStore } from '@/store/gameStore';
import type { BotEngineVersion, BotReign } from '@/store/api/players';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { formatSpan } from '@/ui/duration';
import { Panel, SectionHeading } from '@/ui/primitives';

// What an engine has done, over time: the spells it has spent top of a mode,
// and the builds it has been seen running.
//
// Two lists in one panel because they are read together. The question an author
// actually has is whether the thing they changed worked, and a list of builds
// beside a list of reigns is the closest this page gets to answering it.
//
// The whole panel disappears when there is nothing in either list, rather than
// standing there empty. Most engines have never led a mode and most declare no
// build, so an always-present panel would be two empty states on almost every
// page.

const dateOf = (unixMs: number) => new Date(unixMs).toLocaleDateString();

export interface EngineHistoryProps {
  reigns: BotReign[];
  versions: BotEngineVersion[];
}

export default function EngineHistory({ reigns, versions }: EngineHistoryProps) {
  // Before anything is decided: a hook that runs only on some engines' pages
  // would be a worse bug than the blank panel it was avoiding.
  const now = useNow();
  const modes = useGameStore((state) => state.modes);
  if (reigns.length === 0 && versions.length === 0) return null;

  const modeName = (modeId: string) =>
    modes.find((mode) => mode.id === modeId)?.name ?? modeId;

  return (
    <Panel>
      <SectionHeading eyebrow="RECORD" title="Over time" />

      {reigns.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.label}>TOP OF THE LADDER</Text>
          {/*
            Only from the day the ledger shipped. Said out loud because the
            alternative is a reader taking an engine's first listed reign for
            its first ever, and this page has no way to know that.
          */}
          <Text style={styles.help}>
            Time at number one, newest first. Earlier reigns may not be recorded.
          </Text>
          <View style={styles.list}>
            {reigns.map((reign) => (
              <View key={`${reign.modeId}-${reign.startedAtUnixMs}`} style={styles.row}>
                <Text numberOfLines={1} style={styles.rowName}>
                  {modeName(String(reign.modeId))}
                </Text>
                <Text style={[styles.rowSpan, reign.current && styles.rowSpanCurrent]}>
                  {reign.current
                    ? // Null until the first client render settles, so the
                      // pre-rendered page does not bake in a duration that
                      // stopped growing on the day of the build.
                      now === null
                      ? 'holding it'
                      : `holding it · ${formatSpan(reign.startedAtUnixMs, now)}`
                    : formatSpan(reign.startedAtUnixMs, reign.endedAtUnixMs ?? reign.startedAtUnixMs)}
                </Text>
                <Text style={styles.rowDate}>
                  {dateOf(reign.startedAtUnixMs)}
                  {reign.endedAtUnixMs ? ` – ${dateOf(reign.endedAtUnixMs)}` : ''}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {versions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.label}>BUILDS</Text>
          <Text style={styles.help}>
            Engine builds and when they first played.
          </Text>
          <View style={styles.list}>
            {versions.map((version, index) => (
              <View key={version.version} style={styles.row}>
                <Text numberOfLines={1} style={styles.rowName}>
                  {version.version}
                </Text>
                {/*
                  "Current" is the newest build seen rather than a claim the
                  engine is connected: an engine that has been off for a month
                  is still, when it comes back, the build it last announced.
                */}
                <Text style={[styles.rowSpan, index === 0 && styles.rowSpanCurrent]}>
                  {index === 0 ? 'current' : ''}
                </Text>
                <Text style={styles.rowDate}>{dateOf(version.firstSeenAtUnixMs)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Panel>
  );
}

const styles = themedSheet(() => ({
  section: { gap: space.tight, marginTop: space.small },
  label: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 1.4 },
  help: { ...type.body, color: colors.textMuted },
  list: { marginTop: space.tight, gap: space.hair },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    paddingVertical: space.tight,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    backgroundColor: colors.surface,
  },
  // `minWidth: 0` so a long build string truncates instead of pushing the date
  // off the end of the row. Same note as MobileTopBar.
  rowName: { ...type.rowTitle, color: colors.textStrong, flex: 1, minWidth: 0 },
  rowSpan: { ...type.meta, color: colors.textMuted },
  rowSpanCurrent: { color: colors.goldBright, fontWeight: '700' },
  rowDate: { ...type.meta, color: colors.textFaint },
}));
