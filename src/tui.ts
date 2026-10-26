import { Plugin } from "@opencode/plugin/tui"

/**
 * Optional TUI companion.
 *
 * The server plugin is the primary integration. This entry point exists so the
 * package can later add a status slot and a manual "sync now" command without
 * changing the package layout.
 */
export default Plugin.define({
  id: "ocsync.tui",
  setup() {
    return () => {}
  },
})
