import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { NIGHT } from '@/components/chip';
import { PressableScale } from '@/components/pressable-scale';
import { todayYmd } from '@/utils/event-dates';

type Props = {
  visible: boolean;
  value: string | null; // YYYY-MM-DD
  onSelect: (ymd: string | null) => void;
  onClose: () => void;
};

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Small dependency-free month grid. Dates are plain calendar dates (no time zones involved).
export function CalendarPicker({ visible, value, onSelect, onClose }: Props) {
  const today = todayYmd();
  const start = value ?? today;
  const [year, setYear] = useState(Number(start.slice(0, 4)));
  const [month, setMonth] = useState(Number(start.slice(5, 7)) - 1);

  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array(first.getUTCDay()).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7) cells.push(null);

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <PressableScale haptic="selection" onPress={() => shift(-1)} hitSlop={10}>
              <Text style={styles.nav}>‹</Text>
            </PressableScale>
            <Text style={styles.title}>{title}</Text>
            <PressableScale haptic="selection" onPress={() => shift(1)} hitSlop={10}>
              <Text style={styles.nav}>›</Text>
            </PressableScale>
          </View>
          <View style={styles.week}>
            {WEEKDAYS.map((w, i) => (
              <Text key={i} style={styles.weekday}>
                {w}
              </Text>
            ))}
          </View>
          <View style={styles.grid}>
            {cells.map((day, i) => {
              if (day === null) return <View key={i} style={styles.cell} />;
              const ymd = `${year}-${pad(month + 1)}-${pad(day)}`;
              const selected = ymd === value;
              return (
                <View key={i} style={styles.cell}>
                  <PressableScale
                    haptic="selection"
                    onPress={() => onSelect(ymd)}
                    style={[styles.day, selected && styles.daySelected, ymd === today && !selected && styles.dayToday]}
                    pressableStyle={styles.dayInner}>
                    <Text style={[styles.dayText, selected && styles.dayTextSelected]}>{day}</Text>
                  </PressableScale>
                </View>
              );
            })}
          </View>
          <View style={styles.footer}>
            <PressableScale haptic="selection" onPress={() => onSelect(null)}>
              <Text style={styles.footerText}>Any date</Text>
            </PressableScale>
            <PressableScale haptic="none" onPress={onClose}>
              <Text style={styles.footerText}>Close</Text>
            </PressableScale>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,16,22,0.7)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 360, backgroundColor: NIGHT.card, borderRadius: 28, borderWidth: 1, borderColor: NIGHT.edge, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  nav: { color: NIGHT.pink, fontSize: 28, fontWeight: '700', paddingHorizontal: 10 },
  title: { color: NIGHT.cream, fontSize: 16, fontWeight: '800' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', color: NIGHT.creamDim, fontSize: 12, fontWeight: '700', paddingVertical: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  day: { flex: 1, borderRadius: 999 },
  dayInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: NIGHT.pink },
  dayToday: { borderWidth: 1, borderColor: NIGHT.pink },
  dayText: { color: NIGHT.cream, fontSize: 14, fontWeight: '600' },
  dayTextSelected: { color: NIGHT.charcoal, fontWeight: '800' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 6 },
  footerText: { color: NIGHT.pink, fontSize: 14, fontWeight: '700', paddingVertical: 6 },
});
