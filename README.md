<div align="center">
  <h1>Ark</h1>
  <p><strong>a cockpit for the Claude Code sessions running on your machine</strong></p>
  <p>
    <a href="https://github.com/ignission/claude-code-ark/releases">Releases</a> ·
    <a href="https://github.com/ignission/claude-code-ark/issues">Issues</a> ·
    <a href="README.ja.md">日本語</a>
  </p>
</div>

Ark is a self-hosted web UI that runs one Claude Code session per git worktree and shows all of them in one place, on your desk and on your phone.

It drives the real interactive `claude` CLI inside tmux, so your plan, your settings and your `CLAUDE.md` work exactly as they do in a terminal. No Agent SDK, no API key.

<p align="center">
  <img
    src=".github/assets/ark-board.png"
    width="880"
    alt="Ark on a desktop: a session list on the left, a conversation in the middle, and a sequence diagram Claude drew on the board on the right"
  />
</p>

> [!WARNING]
> Ark is experimental and built for **one user**. Anyone who gets past authentication can reach every session, and requests from localhost or a private IP skip authentication altogether. Do not share an Ark instance with other people, and be careful when you expose it through a tunnel.

## Quickstart

1. Install Ark. On macOS (Apple Silicon) run `brew install --cask ignission/tap/ark`; on Linux, [run it from source](#run-from-source).
2. Open Ark (http://localhost:4001 when run from source), pick a repository, and start a session on a worktree.
3. Ask Claude something. Switch between the chat view and the raw terminal with the toggle at the top.

You need the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude --version`; run `claude` and `/login` if you are not).

## Things to try first

**Have Claude explain a change on the board.** Arrows and rows in the diagram can link to the code behind them.

> Walk me through what happens when I start a session, from the socket event to the terminal showing up in the browser. Draw it on the board as a sequence diagram.

**Drive Ark from the keyboard.** Press `Ctrl+;` to enter normal mode, then `?` for the key list. `J` / `K` move between sessions, `n` jumps to the next session waiting for you, and `:` opens the command palette.

**Answer from your phone.** Start Ark with `pnpm start:quick`, scan the QR code, and answer Claude's questions from the card that appears in the chat.

## Why Ark

### You can tell where every session stands without opening it

The sidebar sorts sessions into "your turn", "working" and "idle". When Claude asks a question, Ark shows it as a card with the options as buttons, together with the terminal screen from just before the question.

### It is the real Claude Code

Ark does not reimplement the agent. Each session is the interactive `claude` CLI in a detached tmux session, shown through [ttyd](https://github.com/tsl0922/ttyd), and the chat view is drawn from Claude's own transcript files. Sessions keep running when the Ark server restarts, and Ark reattaches to them when it comes back.

### Long explanations go on a board, not in the chat

Claude draws sequence diagrams, call trees with diff sizes, and multi-page decks on a board next to the conversation. Links in a diagram open the code beside it. Documents on the board can be edited in place, and you can select any passage, comment on it, and send the comment back to the conversation.

With an [OpenRouter](https://openrouter.ai/) key, Ark can also decide for you when a reply belongs on the board. See [Board suggestions](#board-suggestions).

### You can review without leaving

<p align="center">
  <img
    src=".github/assets/ark-git.png"
    width="880"
    alt="The Git tab: a commit graph with branch labels on top and the diff of the selected commit below"
  />
</p>

- **Git tab**: a commit graph with branch labels, the diff of any commit, and uncommitted changes. It follows along while Claude commits.
- **Files tab**: browse the worktree and edit files in CodeMirror. If Claude rewrites a file while you are editing it, Ark asks whether to reload or overwrite instead of merging silently.

### It works from a phone

<p align="center">
  <img
    src=".github/assets/ark-mobile-sessions.png"
    width="260"
    alt="The session list on a phone, grouped into your turn and idle"
  />
  &nbsp;&nbsp;
  <img
    src=".github/assets/ark-mobile-question.png"
    width="260"
    alt="A question from Claude shown on a phone as a card with numbered options"
  />
</p>

The mobile UI has its own session list, chat view, terminal with quick keys, and Japanese IME support. On iPhone, voice mode sends what you say and reads Claude's reply aloud. Remote access goes through a Cloudflare Tunnel that Ark starts for you.

### More

- Paste, drop or attach images, PDFs, text files and spreadsheets to send them to Claude.
- Ask a side question from the command palette (`Tab`). A separate Claude with no tools answers in a floating window, and your session's conversation is left alone.
- Open the VNC screen of a host you can reach over SSH, such as a Mac's Screen Sharing, in the browser.
- Use a different Claude account per repository (Linux only).

## How it works

```text
view:     <config dir>/projects/<cwd>/*.jsonl → tail → Socket.IO → chat view
input:    chat box → Socket.IO → tmux send-keys → claude CLI
terminal: tmux session ←→ ttyd (WebSocket) ←→ iframe
```

- **tmux** keeps each `claude` process in a detached session, so it outlives the Ark server.
- **ttyd** serves that tmux session as a web terminal, one process per session.
- The chat view reads everything from Claude's transcript files. Ark never parses the terminal screen to recover what was said.
- Session metadata lives in SQLite (`data/sessions.db`).

## Install

### macOS app (Apple Silicon)

```bash
brew install --cask ignission/tap/ark
```

Or download it from [GitHub Releases](https://github.com/ignission/claude-code-ark/releases). Requires macOS 12 (Monterey) or later on arm64; earlier versions are untested.

<details>
<summary>If macOS says "Ark is damaged and can't be opened"</summary>

The `.app` is **not yet signed with a Developer ID or notarized by Apple** (tracked in [#193](https://github.com/ignission/claude-code-ark/issues/193)), so macOS quarantines the downloaded app and reports it as damaged.

> [!CAUTION]
> The steps below deliberately bypass Gatekeeper. Before running them, **confirm that your copy is genuine**:
>
> - It came from `https://github.com/ignission/claude-code-ark/releases`.
> - If you installed through Homebrew Cask, `brew` has already checked the `.zip` against the sha256 in the Cask definition ([`Casks/ark.rb`](https://github.com/ignission/homebrew-tap/blob/main/Casks/ark.rb)), so tampering would have been detected.
> - If you downloaded it directly, compare the sha256 on the GitHub Releases page with the output of `shasum -a 256 Ark-*.zip`.

Once you have confirmed that, remove the quarantine attribute by hand:

```bash
# Assumes the Cask install location (/Applications/Ark.app). Adjust if yours differs.
APP="/Applications/Ark.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: $APP not found. Check where Ark was installed." >&2
  exit 1
fi
xattr -dr com.apple.quarantine "$APP"
```

Homebrew 4.5 removed the `--no-quarantine` switch and the `HOMEBREW_CASK_OPTS=--no-quarantine` environment variable without a replacement ([Homebrew/brew#19046](https://github.com/Homebrew/brew/pull/19046)), so the attribute can only be removed after installation.

</details>

### Run from source

Prerequisites:

- Node.js >= 22.12.0
- [pnpm](https://pnpm.io/)
- [tmux](https://github.com/tmux/tmux)
- [ttyd](https://github.com/tsl0922/ttyd)
- [jq](https://jqlang.org/)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), installed and logged in

```bash
git clone https://github.com/ignission/claude-code-ark.git
cd claude-code-ark
pnpm install
pnpm build
pnpm start
```

Then open http://localhost:4001.

## Remote access

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then:

```bash
pnpm start:quick
```

Ark prints a QR code and a temporary `*.trycloudflare.com` URL protected by a random token. For a fixed domain behind Cloudflare Access, set `ARK_PUBLIC_DOMAIN` and run `pnpm start:remote`.

## Board suggestions

Reading a long explanation in a chat is tiring. When this is on, every time Claude finishes a reply Ark asks [Jev](https://openrouter.ai/docs/guides/community/jev) one question: would this reply be easier to read on the board than in the chat? Jev is a classifier that returns only a probability and generates no text. If the probability reaches the threshold, Claude continues instead of stopping, turns the reply into a deck, and opens it on the board.

- One call takes 200–400 ms and costs $0.042 per million input tokens.
- Ark sends only the last 6,000 characters of the reply, with `data_collection: "deny"`.
- Drawing the deck is done by Claude, so it uses your Claude plan like any other turn.

To turn it on:

1. Create an API key at [OpenRouter](https://openrouter.ai/settings/keys).
2. Open the board suggestion settings from the Ark menu at the top left (on a phone, the slider icon in the session list), paste the key, and save.
3. If it fires too often, raise the threshold (default 0.7) or switch it off on the same screen.

The key is stored in Ark's database, and the UI only ever shows its last four characters. You can also supply it through `OPENROUTER_API_KEY` or `~/.config/openrouter/api-key`; the key from the settings screen takes precedence. Without a key, nothing happens.

Sessions pick this up when their `claude` process starts, so a session that was already running needs a restart before suggestions work in it.

## Configuration

| Option                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `--skip-permissions`    | Start Claude with `--dangerously-skip-permissions`             |
| `--repos /path1,/path2` | Restrict Ark to these repositories                             |
| `--quick` / `-q`        | Start a Quick Tunnel (temporary URL + token authentication)    |
| `--remote` / `-r`       | Start a Named Tunnel (fixed URL + Cloudflare Access)           |

| Environment variable        | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `PORT`                      | Server port (default: 4001)                                       |
| `SKIP_PERMISSIONS`          | `true` to skip permission prompts                                 |
| `ARK_PUBLIC_DOMAIN`         | Fixed domain for the Named Tunnel                                 |
| `ARK_TUNNEL_NAME`           | Named Tunnel name (default: `claude-code-ark`)                    |
| `OPENROUTER_API_KEY`        | API key for board suggestions; the settings screen takes precedence |
| `ARK_FEATURE_BOARD_SUGGEST` | `false` turns board suggestions off                               |

## Known limitations

- **One user only.** There are no per-session permissions, and there is no plan to add them.
- **The macOS app is unsigned** ([#193](https://github.com/ignission/claude-code-ark/issues/193)), and there is no packaged app for Linux or Windows. On Linux, run from source.
- **The Git tab is read-only.** You cannot stage, commit, discard or check out from it.
- **The Files tab edits existing files only.** It cannot create, delete or rename them.
- **The Git tab, file editing and keyboard navigation are desktop only.** On a phone, files open read-only.
- **Per-repository accounts work on Linux only**, because macOS keeps Claude's credentials in the Keychain.
- **Voice mode is for iPhone** and runs only while the screen is on and Ark is in the foreground.
- **The UI is in Japanese.**

## Development

| Command           | Description                     |
| ----------------- | ------------------------------- |
| `pnpm dev`        | Frontend dev server             |
| `pnpm dev:server` | Backend dev server              |
| `pnpm dev:full`   | Both                            |
| `pnpm dev:quick`  | Backend with a Quick Tunnel     |
| `pnpm build`      | Production build                |
| `pnpm start`      | Run the production build        |
| `pnpm check`      | Lint and type check             |
| `pnpm test`       | Unit tests                      |

## License

MIT
