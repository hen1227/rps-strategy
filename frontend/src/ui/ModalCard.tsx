import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, overlay, radius, shadows, space, type } from '@/theme';

// The shell every dialog in this app was writing out by hand.
//
// Three modals — how-to-play, position setup, PGN import — each carried the
// same fade, the same absolute-fill backdrop at the same opacity, the same
// bordered card with the same shadow, and the same 34px close button with the
// same × in it. The differences between the three copies were not choices:
// one had maxHeight 90% and another 94%, one padded 17 and another 18. What
// actually differs between them is how wide the card wants to be, so that is
// the only piece of it a caller passes.

export interface ModalCardProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  subtitle?: string;
  /** How wide the card may grow. A form wants less room than a board. */
  maxWidth?: number;
  /** Rendered at the bottom of the card, outside the scrolling body. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Named for screen readers; falls back to "Close <title>". */
  closeLabel?: string;
}

export default function ModalCard({
  visible,
  onClose,
  title,
  eyebrow,
  subtitle,
  maxWidth = 620,
  footer,
  children,
  closeLabel,
}: ModalCardProps) {
  const dismissLabel = closeLabel ?? `Close ${title}`;
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.root}
      >
        {/*
          The backdrop is a sibling of the card rather than its parent, so a tap
          that lands on the card cannot bubble out and close the dialog the
          person is using.
        */}
        <Pressable
          accessibilityLabel={dismissLabel}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View accessibilityViewIsModal style={[styles.card, { maxWidth }]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              {Boolean(eyebrow) && <Text style={styles.eyebrow}>{eyebrow}</Text>}
              <Text style={styles.title}>{title}</Text>
              {Boolean(subtitle) && <Text style={styles.subtitle}>{subtitle}</Text>}
            </View>
            <Pressable
              accessibilityLabel={dismissLabel}
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeMark}>×</Text>
            </Pressable>
          </View>
          {children}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.medium },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: overlay },
  card: {
    width: '100%',
    maxHeight: '94%',
    padding: space.large,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.modal,
    elevation: 18,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.small },
  headerCopy: { flex: 1 },
  eyebrow: { ...type.eyebrow, color: colors.accentBright },
  title: { ...type.screenTitle, color: colors.textStrong, marginTop: space.tight },
  subtitle: { ...type.meta, color: colors.textMuted, marginTop: space.tight },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceRaised,
  },
  closeMark: { color: colors.textMuted, fontSize: 23, lineHeight: 25 },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: space.small,
    marginTop: space.medium,
  },
  pressed: { opacity: 0.7 },
});
