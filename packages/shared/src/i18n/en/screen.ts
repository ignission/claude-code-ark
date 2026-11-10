import type { Messages } from "../ja";

export const screen: Messages["screen"] = {
  manager: {
    title: "Screens",
    description:
      "Shows the VNC screen of a host reachable over SSH, such as macOS Screen Sharing, inside Ark.",
    registered: (count: number) => `Screens (${count})`,
    add: "Add",
    empty: "No screens yet.",
    edit: "Edit",
    deleteTitle: "Delete this screen?",
    deleteDescription: (name: string) =>
      `Deletes the connection settings for "${name}". Nothing changes on the remote host.`,
    addTitle: "Add screen",
    editTitle: "Edit screen",
    addDescription: "Specify a host the Ark server can reach with an SSH key.",
    editDescription: "Leave the password empty to keep the current one.",
    submitAdd: "Add",
    fields: {
      name: "Name",
      namePlaceholder: "e.g. Build VM",
      sshHost: "SSH host",
      hostPlaceholder: "Hostname or IP address",
      sshPort: "SSH port",
      sshUser: "SSH user",
      vncHost: "VNC host, as seen from the SSH host",
      vncPort: "VNC port",
      vncUser: "VNC username, required for macOS Screen Sharing",
      vncPassword: "VNC password",
    },
    nameRequired: "Enter a name",
    sshHostInvalid: "SSH host must be a hostname or an IP address",
    sshPortInvalid: "SSH port must be an integer from 1 to 65535",
    sshUserInvalid: "Invalid SSH username",
    vncHostInvalid: "VNC host must be a hostname or an IP address",
    vncPortInvalid: "VNC port must be an integer from 1 to 65535",
    vncPasswordRequired: "Enter the VNC password",
  },
  pane: {
    connectFailed: "Failed to connect",
    unregistered:
      "Screen settings not found. Register it again from the screen manager.",
    unavailable: "Can't reach the server. Try reconnecting in a moment.",
    manualDisconnect: "Disconnected",
    authFailed: (reason: string) => `Authentication failed (${reason})`,
    unknownReason: "unknown reason",
    closedCleanly: "The connection was closed",
    connectionLost: "Connection lost",
    insecureContext:
      "Remote screens work only over HTTPS or on localhost, because authentication needs WebCrypto.",
    reconnect: "Reconnect",
    disconnect: "Disconnect",
    connecting: (name: string) => `Connecting to ${name}...`,
  },
};
