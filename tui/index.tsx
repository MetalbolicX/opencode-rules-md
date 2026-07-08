// tui/index.tsx
/** @jsxImportSource @opentui/solid */
import { createRoot } from 'solid-js';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import { SidebarContent } from './slots/sidebar-content.js';

const id = 'opencode-rules' as const;

const tui: TuiPlugin = async api => {
  // createRoot establishes a reactive owner for the slot renderer.
  // The returned dispose function tears down the entire reactive tree.
  // Register it with the host lifecycle so Solid owner cleanup runs
  // when OpenCode unloads the plugin.
  const dispose = createRoot(disposeInner => {
    api.slots.register({
      order: 350,
      slots: {
        sidebar_content: (ctx, props) => (
          <SidebarContent
            sessionId={props.session_id}
            api={api}
            theme={ctx.theme}
          />
        ),
      },
    });
    // Return the inner dispose — called when the plugin is torn down
    return disposeInner;
  });

  api.lifecycle.onDispose(dispose);
};

export default { id, tui };
