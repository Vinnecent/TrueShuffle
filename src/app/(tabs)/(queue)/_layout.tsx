import { Stack } from 'expo-router';

import { stackScreenOptions } from '@/theme';

export default function QueueLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Queue' }} />
    </Stack>
  );
}
