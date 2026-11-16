package org.nanosync.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

/** Direct shared-storage adapter; no DocumentsProvider or private mirror.
 *
 * All paths are revalidated before operations, links fail closed, and enumeration errors
 * invalidate the entire scan. Android's emulated storage does not offer portable dirfd-relative
 * atomic compare-and-replace. Concurrent hostile directory replacement is NOT supported: this
 * adapter requires a user-controlled root. Metadata guards detect ordinary edits, not adversarial
 * same-size/same-mtime changes. Device/filesystem durability and permission behavior must be gated
 * before enabling real sync; ATOMIC_MOVE failure is never downgraded to destructive replacement.
 */
public final class FolderAccess {
    public static final int MAX_CHUNK = 4 * 1024 * 1024;
    private static final String TEMP_PREFIX = ".nanosync-tmp-";
    private final Context context;
    private final File root;
    private final File stages;

    public FolderAccess(Context context, File root, File journalDirectory) throws IOException {
        this.context = context.getApplicationContext();
        this.root = root.getAbsoluteFile();
        File external = Environment.getExternalStorageDirectory().getCanonicalFile();
        File canonical = root.getCanonicalFile();
        if (!canonical.toPath().startsWith(external.toPath()) || canonical.equals(external)
                || canonical.toPath().startsWith(new File(external, "Android").toPath())) {
            throw new IOException("Select a dedicated folder under primary shared storage, outside Android/");
        }
        if (!this.root.toPath().normalize().equals(canonical.toPath())) throw new IOException("Root contains a link or alias");
        File journal = validateJournalDirectory(context, journalDirectory);
        if (overlaps(root, journal)) throw new IOException("Journal overlaps shared root");
        stages = new File(journal, "stages");
        if ((!stages.isDirectory() && !stages.mkdir()) || Files.isSymbolicLink(stages.toPath()))
            throw new IOException("Cannot open private stages");
        checkAccessible();
    }

    public static File validateJournalDirectory(Context context, File directory) throws IOException {
        File files = context.getFilesDir().getCanonicalFile();
        File absolute = directory.getAbsoluteFile();
        File canonical = directory.getCanonicalFile();
        if (!absolute.toPath().normalize().equals(canonical.toPath())
                || !canonical.toPath().startsWith(files.toPath()) || canonical.equals(files))
            throw new IOException("Journal must be a dedicated non-linked private files directory");
        if (!canonical.isDirectory() && !canonical.mkdirs()) throw new IOException("Cannot create journal");
        return canonical;
    }

    public static boolean overlaps(File first, File second) throws IOException {
        Path a = first.getCanonicalFile().toPath(), b = second.getCanonicalFile().toPath();
        return a.startsWith(b) || b.startsWith(a);
    }

    public static void validatePath(String path, boolean read) {
        if (path == null || path.isEmpty() || path.indexOf('\\') >= 0 || path.startsWith("/"))
            throw new IllegalArgumentException("Invalid relative path");
        for (String part : path.split("/", -1)) {
            String lower = part.toLowerCase(Locale.ROOT);
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.endsWith(".") || part.endsWith(" ")
                    || part.length() > 255 || lower.startsWith(".nanosync")
                        && !(read && path.equals(".nanosyncignore")))
                throw new IllegalArgumentException("Unsafe or reserved path");
            for (int i = 0; i < part.length(); i++)
                if (Character.isISOControl(part.charAt(i)) || ":*?\"<>|".indexOf(part.charAt(i)) >= 0)
                    throw new IllegalArgumentException("Unsafe path character");
        }
    }

    public void checkAccessible() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
        if (Build.VERSION.SDK_INT >= 30) {
            if (!Environment.isExternalStorageManager()) throw new IOException("All-files storage access is required");
        } else if (context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            throw new IOException("Shared storage permission is required");
        }
        if (!Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(root))
                || !root.isDirectory() || !root.canRead() || !root.canWrite()
                || !root.getCanonicalFile().equals(root) || Files.isSymbolicLink(root.toPath()))
            throw new IOException("Shared root is unavailable");
        // Opening a directory must succeed: a missing entry may not conceal permission loss.
        try (DirectoryStream<Path> ignored = Files.newDirectoryStream(root.toPath())) { }
    }

    private File resolve(String relative, boolean read) throws IOException {
        checkAccessible();
        validatePath(relative, read);
        File current = root;
        String[] parts = relative.split("/");
        for (int i = 0; i < parts.length; i++) {
            current = new File(current, parts[i]);
            if (Files.isSymbolicLink(current.toPath())) throw new IOException("Symbolic links are unsupported");
            if (!current.getCanonicalFile().equals(current)) throw new IOException("Path escapes root");
            if (i < parts.length - 1 && (!current.isDirectory() || !current.canRead()))
                throw new IOException("Parent directory is unavailable");
        }
        return current;
    }

    private static BasicFileAttributes attrs(File file) throws IOException {
        BasicFileAttributes a = Files.readAttributes(file.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!a.isRegularFile() && !a.isDirectory()) throw new IOException("Unsupported entry (including symbolic link)");
        return a;
    }

    private static JSONObject metadata(String path, BasicFileAttributes a) throws Exception {
        JSONObject result = new JSONObject().put("path", path).put("directory", a.isDirectory())
            .put("size", a.isDirectory() ? 0 : a.size()).put("modified", a.lastModifiedTime().toMillis());
        if (a.fileKey() != null) result.put("fileKey", a.fileKey().toString());
        return result;
    }

    private static boolean same(BasicFileAttributes a, BasicFileAttributes b) {
        return a.size() == b.size() && a.lastModifiedTime().equals(b.lastModifiedTime())
            && a.isDirectory() == b.isDirectory() && java.util.Objects.equals(a.fileKey(), b.fileKey());
    }

    public JSONArray list() throws Exception {
        checkAccessible();
        JSONArray result = new JSONArray();
        enumerate(root, "", result);
        checkAccessible();
        return result;
    }

    /** Shallow inventory lets JS apply ignore rules BEFORE descending; symlinks are never followed. */
    public JSONArray listDirectory(String path) throws Exception {
        checkAccessible();
        File directory = path.isEmpty() ? root : resolve(path, true);
        BasicFileAttributes before = attrs(directory);
        if (!before.isDirectory()) throw new IOException("Not a directory");
        JSONArray result = new JSONArray();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory.toPath())) {
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (name.toLowerCase(Locale.ROOT).startsWith(TEMP_PREFIX)) continue;
                String relative = path.isEmpty() ? name : path + "/" + name;
                validatePath(relative, true);
                BasicFileAttributes a = Files.readAttributes(entry, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (a.isSymbolicLink()) {
                    result.put(metadata(relative, a).put("symlink", true));
                } else {
                    if (!a.isRegularFile() && !a.isDirectory()) throw new IOException("Unsupported entry");
                    result.put(metadata(relative, a));
                }
            }
        }
        checkAccessible();
        if (!same(before, attrs(path.isEmpty() ? root : resolve(path, true)))) throw new IOException("Directory changed during listing");
        return result;
    }

    private void enumerate(File directory, String prefix, JSONArray result) throws Exception {
        BasicFileAttributes before = attrs(directory);
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory.toPath())) {
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (name.toLowerCase(Locale.ROOT).startsWith(TEMP_PREFIX)) continue;
                String relative = prefix + name;
                File file = resolve(relative, true);
                BasicFileAttributes a = attrs(file); // Links and any traversal error fail the WHOLE scan.
                result.put(metadata(relative, a));
                if (a.isDirectory()) enumerate(file, relative + "/", result);
            }
        }
        if (!same(before, attrs(directory))) throw new IOException("Directory changed during enumeration");
    }

    public JSONObject stat(String path) throws Exception {
        if (path.isEmpty()) { checkAccessible(); return metadata("", attrs(root)); }
        File file = resolve(path, true);
        try { return metadata(path, attrs(file)); }
        catch (java.nio.file.NoSuchFileException missing) {
            checkAccessible();
            if (!file.getParentFile().isDirectory() || !file.getParentFile().canRead()) throw new IOException("Parent unavailable");
            return new JSONObject().put("missing", true);
        }
    }

    private FileInputStream openRead(File file) throws Exception {
        return new FileInputStream(Os.open(file.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0));
    }

    public JSONObject read(String path, long offset, int length) throws Exception {
        if (offset < 0 || length < 0 || length > MAX_CHUNK) throw new IOException("Invalid read range");
        File file = resolve(path, true);
        BasicFileAttributes before = attrs(file);
        if (!before.isRegularFile()) throw new IOException("Not a regular file");
        byte[] data = new byte[length];
        int count = 0;
        try (FileInputStream in = openRead(file)) {
            in.getChannel().position(offset);
            while (count < length) {
                int n = in.read(data, count, length - count);
                if (n < 0) break;
                count += n;
            }
        }
        if (!same(before, attrs(resolve(path, true)))) throw new IOException("File changed during read");
        return metadata(path, before).put("dataBase64", Base64.encodeToString(data, 0, count, Base64.NO_WRAP))
            .put("eof", offset >= before.size() || count >= before.size() - offset);
    }

    public JSONObject digest(String path) throws Exception {
        File file = resolve(path, true);
        BasicFileAttributes before = attrs(file);
        if (!before.isRegularFile()) throw new IOException("Not a regular file");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        long size = 0;
        try (FileInputStream in = openRead(file)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
                hash.update(buffer, 0, n); size += n;
            }
        }
        if (size != before.size() || !same(before, attrs(resolve(path, true)))) throw new IOException("File changed during digest");
        StringBuilder hex = new StringBuilder(64);
        for (byte b : hash.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
        return metadata(path, before).put("sha256", hex.toString());
    }

    private File stage(String id) throws IOException {
        checkAccessible();
        if (!UUID.fromString(id).toString().equals(id)) throw new IOException("Invalid stage UUID");
        File file = new File(stages, id);
        if (Files.isSymbolicLink(file.toPath()) || !file.getCanonicalFile().equals(file)) throw new IOException("Invalid stage");
        return file;
    }

    public JSONObject stageRead(String id, long offset, int length) throws Exception {
        if (offset < 0 || length < 0 || length > MAX_CHUNK) throw new IOException("Invalid stage read range");
        File file = stage(id);
        BasicFileAttributes before = attrs(file);
        if (!before.isRegularFile()) throw new IOException("Not a stage file");
        byte[] data = new byte[length]; int count = 0;
        try (FileInputStream in = openRead(file)) {
            in.getChannel().position(offset);
            while (count < length) {
                int n = in.read(data, count, length - count);
                if (n < 0) break;
                count += n;
            }
        }
        if (!same(before, attrs(file))) throw new IOException("Stage changed during read");
        return new JSONObject().put("dataBase64", Base64.encodeToString(data, 0, count, Base64.NO_WRAP))
            .put("size", before.size()).put("eof", offset >= before.size() || count >= before.size() - offset);
    }

    public JSONObject stageDigest(String id) throws Exception {
        File file = stage(id);
        BasicFileAttributes before = attrs(file);
        if (!before.isRegularFile()) throw new IOException("Not a stage file");
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); long size = 0;
        try (FileInputStream in = openRead(file)) {
            byte[] buffer = new byte[64 * 1024]; int n;
            while ((n = in.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
                hash.update(buffer, 0, n); size += n;
            }
        }
        if (size != before.size() || !same(before, attrs(file))) throw new IOException("Stage changed during digest");
        StringBuilder hex = new StringBuilder(64);
        for (byte b : hash.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
        return new JSONObject().put("sha256", hex.toString()).put("size", size);
    }

    public void stageWrite(String id, long offset, String encoded) throws Exception {
        if (offset < 0 || encoded.length() > ((MAX_CHUNK + 2) / 3) * 4) throw new IOException("Invalid stage range");
        byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
        if (bytes.length > MAX_CHUNK) throw new IOException("Chunk too large");
        File file = stage(id);
        try (RandomAccessFile out = new RandomAccessFile(file, "rw")) {
            if (out.length() < offset) throw new IOException("Stage writes cannot leave holes");
            // A crash can leave bytes beyond the journal checkpoint. Replaying that checkpoint
            // replaces only its uncommitted suffix; the authenticated prefix remains untouched.
            out.setLength(offset);
            out.seek(offset); out.write(bytes); out.getFD().sync();
        }
    }

    private void guard(File target, JSONObject expected) throws Exception {
        if (expected == null) throw new IOException("Expected metadata or {missing:true} is required for mutation");
        if (expected.optBoolean("missing", false)) {
            if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("Target appeared");
        } else {
            BasicFileAttributes a = attrs(target);
            if ((a.isDirectory() ? 0 : a.size()) != expected.getLong("size") || a.lastModifiedTime().toMillis() != expected.getLong("modified")
                    || expected.has("fileKey") && !expected.getString("fileKey").equals(String.valueOf(a.fileKey())))
                throw new IOException("Target changed");
        }
    }

    public void stageCommit(String id, String path, JSONObject expected) throws Exception {
        File source = stage(id), target = resolve(path, false);
        if (!source.isFile()) throw new IOException("Stage missing");
        guard(target, expected);
        Path temp = Files.createTempFile(target.getParentFile().toPath(), TEMP_PREFIX, ".stage");
        try {
            try (FileInputStream in = openRead(source); FileOutputStream out = new FileOutputStream(temp.toFile())) {
                byte[] buffer = new byte[64 * 1024]; int n;
                while ((n = in.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
                    out.write(buffer, 0, n);
                }
                out.getFD().sync();
            }
            target = resolve(path, false);
            guard(target, expected);
            if (target.isDirectory()) throw new IOException("Cannot replace directory");
            Files.move(temp, target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            // Keep the private stage until explicit stageDelete (checkpoint/retry ownership belongs to JS).
        } finally { Files.deleteIfExists(temp); }
    }

    public void stageDelete(String id) throws Exception { Files.deleteIfExists(stage(id).toPath()); }
    public void mkdir(String path) throws Exception {
        File file = resolve(path, false);
        if (!file.isDirectory()) Files.createDirectory(file.toPath());
    }
    public void remove(String path, JSONObject expected) throws Exception {
        File file = resolve(path, false); guard(file, expected);
        Files.delete(file.toPath()); // Nonempty directories are never recursively deleted.
    }
    public void move(String from, String to, JSONObject expected) throws Exception {
        File source = resolve(from, false), target = resolve(to, false);
        guard(source, expected);
        if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("Destination already exists");
        // No REPLACE_EXISTING; user-controlled root/concurrent mutation limitation documented above.
        Files.move(source.toPath(), target.toPath());
    }
    public long capacity() throws IOException { checkAccessible(); return root.getUsableSpace(); }

    public JSONObject capacityInfo() throws Exception {
        checkAccessible();
        long shared = root.getUsableSpace(), privateBytes = stages.getUsableSpace();
        if (Environment.isExternalStorageEmulated(root)) {
            // /storage/emulated and private files usually share /data despite different st_dev.
            // Omit separate capacity so the caller must reserve both allocations together.
            return new JSONObject().put("availableBytes", Math.min(shared, privateBytes));
        }
        return new JSONObject().put("availableBytes", shared).put("privateAvailableBytes", privateBytes);
    }
}
