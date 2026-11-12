import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

const OverlayContext = createContext<(content: ReactNode) => void>(() => {});

/**
 * A layer above the whole app (headers and tab bar included) in the app's own window. Unlike a Modal (a
 * separate Android window), it updates in the same frame as the screens below and disappears the moment it
 * is unmounted, without waiting for Android to close a window.
 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  return (
    <OverlayContext.Provider value={setContent}>
      {children}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {content}
      </View>
    </OverlayContext.Provider>
  );
}

/**
 * Shows its children in the OverlayProvider's layer while mounted. Layout effects, so the layer changes in the
 * same frame as the render that changed it (e.g. the queue row reappearing as the menu's copy of it goes).
 */
export function Overlay({ children }: { children: ReactNode }) {
  const show = useContext(OverlayContext);
  useLayoutEffect(() => {
    show(children);
  }, [show, children]);
  useLayoutEffect(() => () => show(null), [show]);
  return null;
}
