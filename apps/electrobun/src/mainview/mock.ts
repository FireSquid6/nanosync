export const STORAGE_KEY = "nanosync.desktop.mock.v1";
export type EnrollmentStatus =
  "pending" | "approved" | "denied" | "expired" | "error";
export type FolderStatus =
  | "Syncing"
  | "Up to date"
  | "Offline"
  | "Folder unavailable"
  | "Access revoked"
  | "Conflicts";
export interface Folder {
  id: string;
  name: string;
  server: string;
  vault: string;
  path: string;
  status: FolderStatus;
  owner: "Desktop" | "CLI";
  paused: boolean;
  last: string;
  pending: number;
  rules: string;
}
export interface Connection {
  id: string;
  name: string;
  url: string;
  credential: "os" | "locked" | "protected-file";
  admin: boolean;
}
export interface Enrollment {
  connectionId?: string;
  id: string;
  code: string;
  server: string;
  name: string;
  device: string;
  status: EnrollmentStatus;
  outcome: EnrollmentStatus;
  admin: boolean;
  step: number;
  vault: string;
  path: string;
  consent: boolean;
}
export interface MockState {
  version: 1;
  globalPaused: boolean;
  quit: boolean;
  hidden: boolean;
  folders: Folder[];
  connections: Connection[];
  conflicts: { id: string; folder: string; file: string; copy: string }[];
  enrollment: Enrollment | null;
  settings: {
    startAtLogin: boolean;
    background: boolean;
    notifications: boolean;
    conflicts: boolean;
    revoked: boolean;
    failures: boolean;
    includePaths: boolean;
    theme: "light" | "dark" | "system";
  };
}
export function initialState(): MockState {
  return {
    version: 1,
    globalPaused: false,
    quit: false,
    hidden: false,
    connections: [
      {
        id: "home",
        name: "home",
        url: "https://sync.home.example",
        credential: "os",
        admin: true,
      },
      {
        id: "offsite",
        name: "offsite",
        url: "https://sync.offsite.example",
        credential: "os",
        admin: false,
      },
      {
        id: "headless",
        name: "headless",
        url: "https://headless.example",
        credential: "protected-file",
        admin: false,
      },
      {
        id: "locked",
        name: "locked",
        url: "https://locked.example",
        credential: "locked",
        admin: false,
      },
    ],
    folders: [
      {
        id: "documents",
        name: "Documents",
        server: "home",
        vault: "documents",
        path: "/home/alex/Documents",
        status: "Syncing",
        owner: "Desktop",
        paused: false,
        last: "Today, 10:42",
        pending: 12,
        rules: "# Device-local rules\ncache/\n*.tmp\n",
      },
      {
        id: "notes",
        name: "Notes",
        server: "home",
        vault: "notes",
        path: "/home/alex/Notes",
        status: "Conflicts",
        owner: "Desktop",
        paused: false,
        last: "Today, 10:38",
        pending: 2,
        rules: "",
      },
      {
        id: "reference",
        name: "Documents · second copy",
        server: "home",
        vault: "documents",
        path: "/home/alex/Work/reference",
        status: "Up to date",
        owner: "CLI",
        paused: true,
        last: "Yesterday, 18:21",
        pending: 0,
        rules: "",
      },
      {
        id: "media",
        name: "Media",
        server: "offsite",
        vault: "media",
        path: "/mnt/archive/media",
        status: "Folder unavailable",
        owner: "Desktop",
        paused: false,
        last: "Yesterday, 23:14",
        pending: 0,
        rules: "",
      },
      {
        id: "archive",
        name: "Archive",
        server: "offsite",
        vault: "archive",
        path: "/home/alex/Archive",
        status: "Offline",
        owner: "Desktop",
        paused: false,
        last: "Yesterday",
        pending: 1,
        rules: "",
      },
      {
        id: "locked-copy",
        name: "Private",
        server: "locked",
        vault: "private",
        path: "/home/alex/Private",
        status: "Up to date",
        owner: "Desktop",
        paused: false,
        last: "Yesterday",
        pending: 0,
        rules: "",
      },
      {
        id: "revoked",
        name: "Shared",
        server: "offsite",
        vault: "shared",
        path: "/home/alex/Shared",
        status: "Access revoked",
        owner: "Desktop",
        paused: false,
        last: "Yesterday",
        pending: 1,
        rules: "",
      },
      {
        id: "ready",
        name: "Research",
        server: "home",
        vault: "research",
        path: "/home/alex/Research",
        status: "Up to date",
        owner: "Desktop",
        paused: false,
        last: "Today, 10:45",
        pending: 0,
        rules: "",
      },
    ],
    conflicts: ["project-plan", "reading-list"].map((file, i) => ({
      id: String(i),
      folder: "notes",
      file: `${file}.md`,
      copy: `${file} (conflict-laptop).md`,
    })),
    enrollment: null,
    settings: {
      startAtLogin: false,
      background: true,
      notifications: true,
      conflicts: true,
      revoked: true,
      failures: true,
      includePaths: false,
      theme: "system",
    },
  };
}
export function loadState(): MockState {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "null",
    ) as MockState | null;
    if (
      value?.version === 1 &&
      Array.isArray(value.folders) &&
      Array.isArray(value.connections) &&
      value.settings &&
      Array.isArray(value.conflicts)
    )
      return value;
  } catch {
    /* Invalid or unavailable browser storage starts a fresh demo. */
  }
  return initialState();
}
export function folderStatus(state: MockState, folder: Folder): string {
  const credential = state.connections.find(
    (c) => c.id === folder.server,
  )?.credential;
  if (credential === "locked") return "Credentials locked";
  if (credential === "protected-file") return "Migration decision required";
  if (
    ["Conflicts", "Folder unavailable", "Access revoked"].includes(
      folder.status,
    )
  )
    return folder.status;
  if (state.globalPaused || folder.paused) return "Paused";
  if (state.quit && folder.owner === "Desktop") return "Desktop stopped";
  return folder.status;
}
export function normalizePath(path: string): string {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Choose an absolute path without . or .. segments.");
  return path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
export function overlaps(a: string, b: string): boolean {
  return (
    a === b ||
    a === "/" ||
    b === "/" ||
    a.startsWith(b + "/") ||
    b.startsWith(a + "/")
  );
}
