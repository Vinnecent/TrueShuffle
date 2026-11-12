import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { stackScreenOptions } from '@/theme';

export default function ArtistsLayout() {
  const { t } = useTranslation();
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: t('tabs.artists') }} />
      <Stack.Screen name="[id]" options={{ title: '' }} />
    </Stack>
  );
}
