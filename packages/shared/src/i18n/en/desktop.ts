import type { Messages } from "../ja";

export const desktop: Messages["desktop"] = {
  bundledClaudeMissing: {
    title: "Ark: bundled Claude CLI not found",
    body: paths =>
      `The app bundle appears to be incomplete. Try reinstalling Ark.app.\n\nPaths checked:\n${paths}\n\nSee the log for details.`,
  },
};
