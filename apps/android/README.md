# Android filesystem prototype

Open `apps/android` in Android Studio or run `gradle :app:assembleDebug` here with
Android SDK 36 installed and `ANDROID_HOME` set. The installed app exposes a
"Nanosync" location in Android's system Files picker. This is a **local-only
prototype**, not a vault sync client: it has no login, encryption, remote
connection, or UI yet. Do not put sensitive vault contents in it. Files are in
the app's private storage, and other apps access them through DocumentsProvider,
not through a globally mounted POSIX directory.

Document IDs are stable UUIDs independent of path. The SQLite index records
parent/name/type and a persistent ordered change log for edits made through the
provider; future sync integration must consume changes only after a successful
publish.
Writes use private staging files and commit on descriptor close; a killed process
can leave a stage behind, but cannot partially replace the previous file. The
next step is a durable write-intent/recovery implementation and a native vault
storage adapter, followed by instrumentation tests with real document clients.
