import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Agentation } from 'agentation';
import { DialRoot, useDialKit } from 'dialkit';
import 'dialkit/styles.css';
import BugReportDialog from './BugReportDialog';
import { useAutoUpdater } from './useAutoUpdater';

type RootLayoutProps = {
  children: ReactNode;
};

/** Registers at least one DialKit panel; DialRoot renders nothing until a panel exists. */
const DialKitBootstrap = () => {
  useDialKit('Cobble', {
    preview: [1, 0, 1],
  });
  return null;
};

const VISIBILITY_KEY = 'cobble.chrome-ui-hidden';

const RootLayout = ({ children }: RootLayoutProps) => {
  useAutoUpdater();
  const [uiHidden, setUiHidden] = useState(() => window.localStorage.getItem(VISIBILITY_KEY) !== 'false');

  useEffect(() => {
    setUiHidden(window.localStorage.getItem(VISIBILITY_KEY) !== 'false');
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setUiHidden((value) => {
          const nextValue = !value;
          window.localStorage.setItem(VISIBILITY_KEY, String(nextValue));
          return nextValue;
        });
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      {children}
      <BugReportDialog />
      <DialKitBootstrap />
      {!uiHidden && (
        <>
          {/* productionEnabled: show in Vite production / Tauri release (defaults off when NODE_ENV is production) */}
          <DialRoot productionEnabled defaultOpen={false} theme="system" />
          <Agentation />
        </>
      )}
    </>
  );
};

export default RootLayout;
