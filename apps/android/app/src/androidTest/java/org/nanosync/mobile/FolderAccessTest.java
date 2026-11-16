package org.nanosync.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.UUID;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Real shared-storage tests skip without the explicit device all-files/storage grant. */
@RunWith(AndroidJUnit4.class)
public final class FolderAccessTest {
    private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }

    @Test public void unsafePaths() throws Exception {
        for (String path : new String[]{"../escape", "/absolute", "a//b", "a/./b", "a\\b", ".nanosync/state", ".nanosync-tmp-x", "a\u0000b"}) {
            try { FolderAccess.validatePath(path, false); fail(path); }
            catch (IllegalArgumentException expected) { }
        }
        FolderAccess.validatePath("a/file.txt", false);
        FolderAccess.validatePath(".nanosyncignore", true);
        try { FolderAccess.validatePath(".nanosyncignore", false); fail(); }
        catch (IllegalArgumentException expected) { }
    }

    @Test public void overlapIsComponentAware() throws Exception {
        File root = context().getCacheDir();
        assertTrue(FolderAccess.overlaps(new File(root, "one"), new File(root, "one/two")));
        assertTrue(FolderAccess.overlaps(new File(root, "one"), new File(root, "one")));
        assertFalse(FolderAccess.overlaps(new File(root, "one"), new File(root, "one-more")));
    }

    @Test public void symlinkAliasOverlaps() throws Exception {
        File base = Files.createTempDirectory(context().getCacheDir().toPath(), "overlap").toFile();
        File target = new File(base, "target");
        assertTrue(target.mkdir());
        File alias = new File(base, "alias");
        try {
            Files.createSymbolicLink(alias.toPath(), target.toPath());
            assertTrue(FolderAccess.overlaps(alias, target));
        } finally { alias.delete(); target.delete(); base.delete(); }
    }

    private final class Fixture implements AutoCloseable {
        final File root;
        final File journal;
        final FolderAccess access;
        Fixture() throws Exception {
            assumeTrue(Build.VERSION.SDK_INT >= 30 ? Environment.isExternalStorageManager()
                : context().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED);
            root = new File(Environment.getExternalStorageDirectory(), "Nanosync-test-" + UUID.randomUUID());
            journal = new File(context().getFilesDir(), "test-journal-" + UUID.randomUUID());
            assertTrue(root.mkdir());
            access = new FolderAccess(context(), root, journal);
        }
        @Override public void close() throws Exception { clean(root); clean(journal); }
    }
    private static void clean(File file) throws Exception {
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory()) {
            File[] entries = file.listFiles();
            if (entries != null) for (File entry : entries) clean(entry);
        }
        Files.deleteIfExists(file.toPath());
    }

    @Test public void failedEnumerationNeverReturnsPartialSuccess() throws Exception {
        try (Fixture f = new Fixture()) {
            Files.write(new File(f.root, "good.txt").toPath(), new byte[]{1});
            // Unsupported control entry invalidates scan even if another entry was already read.
            Files.write(new File(f.root, ".nanosync").toPath(), new byte[]{2});
            try { f.access.list(); fail("Partial list must not escape"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void shallowListingDoesNotTraverseIgnoredCandidates() throws Exception {
        try (Fixture f = new Fixture()) {
            File ignored = new File(f.root, "ignored"); assertTrue(ignored.mkdir());
            Files.write(new File(ignored, ".nanosync").toPath(), new byte[]{1});
            assertEquals(1, f.access.listDirectory("").length());
            assertEquals("ignored", f.access.listDirectory("").getJSONObject(0).getString("path"));
        }
    }

    @Test public void rootLossIsNotMissingEntry() throws Exception {
        try (Fixture f = new Fixture()) {
            assertTrue(f.root.delete());
            try { f.access.stat("missing.txt"); fail("Unavailable root is not a deletion"); }
            catch (IOException expected) { }
            try { f.access.capacity(); fail("Unavailable root has no usable capacity"); }
            catch (IOException expected) { }
        }
    }

    private static int descriptorCount(File scope) throws Exception {
        int count = 0;
        String prefix = scope == null ? null : scope.getCanonicalPath() + "/";
        File[] descriptors = new File("/proc/self/fd").listFiles();
        assertNotNull(descriptors);
        for (File descriptor : descriptors) {
            try {
                String target = android.system.Os.readlink(descriptor.getPath());
                if (prefix == null || target.startsWith(prefix)) count++;
            } catch (android.system.ErrnoException vanished) { /* fd directory enumeration itself closed */ }
        }
        return count;
    }

    @Test public void noFollowReadsAndCommitCopiesCloseOwnedDescriptors() throws Exception {
        try (Fixture f = new Fixture()) {
            Files.write(new File(f.root, "source").toPath(), new byte[]{1, 2, 3});
            String id = UUID.randomUUID().toString();
            f.access.stageWrite(id, 0, "YWJj");
            // Warm up lazy digest/channel initialization before measuring.
            f.access.digest("source"); f.access.stageDigest(id);
            int before = descriptorCount(null);
            int sharedBefore = descriptorCount(f.root), privateBefore = descriptorCount(f.journal);
            for (int i = 0; i < 64; i++) {
                f.access.read("source", 0, 3); f.access.digest("source");
                f.access.stageRead(id, 0, 3); f.access.stageDigest(id);
                f.access.stageCommit(id, "committed", f.access.stat("committed"));
            }
            assertEquals(sharedBefore, descriptorCount(f.root));
            assertEquals(privateBefore, descriptorCount(f.journal));
            assertTrue("/proc/self/fd must not grow per read", descriptorCount(null) <= before + 8);
        }
    }

    /** Simulate the durable on-disk protocol at a process-death boundary, not a live runtime. */
    private static File staleCommit(Fixture f, String stageId, String target, boolean verified) throws Exception {
        String token = UUID.randomUUID().toString();
        File temp = new File(f.root, ".nanosync-tmp-" + token + ".stage");
        JSONObject intent = new JSONObject().put("version", 1).put("root", f.root.getCanonicalPath())
            .put("target", target).put("stageId", stageId).put("token", token);
        android.system.StructStat parent = android.system.Os.stat(f.root.getPath());
        intent.put("parentDevice", parent.st_dev).put("parentInode", parent.st_ino);
        writeIntent(f, intent); // durable intent always precedes the shared file
        Files.write(temp.toPath(), new byte[]{4, 5}); // interrupted partial copy
        if (verified) {
            android.system.StructStat stat = android.system.Os.lstat(temp.getPath());
            intent.put("device", stat.st_dev).put("inode", stat.st_ino);
            writeIntent(f, intent); // identity is persisted before any production copy writes
        }
        return temp;
    }

    private static void writeIntent(Fixture f, JSONObject intent) throws Exception {
        android.util.AtomicFile file = new android.util.AtomicFile(new File(f.journal, "commit-intent.json"));
        java.io.FileOutputStream out = file.startWrite();
        try {
            out.write(intent.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            out.getFD().sync(); file.finishWrite(out);
        } catch (Exception e) { file.failWrite(out); throw e; }
    }

    @Test public void restartReclaimsOnlyVerifiedPartialCommitAndRetriesPrivateStage() throws Exception {
        try (Fixture f = new Fixture()) {
            String id = UUID.randomUUID().toString();
            f.access.stageWrite(id, 0, "YWJj");
            Files.write(new File(f.root, "target").toPath(), new byte[]{9});
            File unrelated = new File(f.root, ".nanosync-tmp-user.stage");
            Files.write(unrelated.toPath(), new byte[]{8});
            File temp = staleCommit(f, id, "target", true);
            FolderAccess reopened = new FolderAccess(context(), f.root, f.journal);
            assertFalse(temp.exists());
            assertArrayEquals(new byte[]{8}, Files.readAllBytes(unrelated.toPath()));
            assertArrayEquals(new byte[]{9}, Files.readAllBytes(new File(f.root, "target").toPath()));
            assertEquals("YWJj", reopened.stageRead(id, 0, 3).getString("dataBase64"));
            reopened.stageCommit(id, "target", reopened.stat("target"));
            assertArrayEquals(new byte[]{97, 98, 99}, Files.readAllBytes(new File(f.root, "target").toPath()));
            assertFalse(new File(f.journal, "commit-intent.json").exists());
        }
    }

    @Test public void restartNeverDeletesReplacedOrUnverifiedTemp() throws Exception {
        try (Fixture f = new Fixture()) {
            String id = UUID.randomUUID().toString();
            f.access.stageWrite(id, 0, "YWJj");
            File temp = staleCommit(f, id, "target", true);
            // Retain the original inode so the replacement cannot accidentally reuse it.
            Files.move(temp.toPath(), new File(f.root, "retained-original").toPath());
            Files.write(temp.toPath(), new byte[]{7});
            try { new FolderAccess(context(), f.root, f.journal); fail("Foreign inode must block recovery"); }
            catch (IOException expected) { }
            assertArrayEquals(new byte[]{7}, Files.readAllBytes(temp.toPath()));
        }
        try (Fixture f = new Fixture()) {
            String id = UUID.randomUUID().toString();
            File temp = staleCommit(f, id, "target", false);
            try { new FolderAccess(context(), f.root, f.journal); fail("Unknown ownership must fail closed"); }
            catch (IOException expected) { }
            assertTrue(temp.exists());
        }
    }

    @Test public void stagesPersistAndMissingGuardPreservesUntrackedFile() throws Exception {
        try (Fixture f = new Fixture()) {
            String id = UUID.randomUUID().toString();
            f.access.stageWrite(id, 0, "YWJj");
            FolderAccess reopened = new FolderAccess(context(), f.root, f.journal);
            assertEquals(3, reopened.stageRead(id, 0, 4).getLong("size"));
            assertEquals("YWJj", reopened.stageRead(id, 0, 4).getString("dataBase64"));
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", reopened.stageDigest(id).getString("sha256"));
            File target = new File(f.root, "existing");
            Files.write(target.toPath(), new byte[]{9});
            try { reopened.stageCommit(id, "existing", new JSONObject().put("missing", true)); fail(); }
            catch (IOException expected) { }
            assertArrayEquals(new byte[]{9}, Files.readAllBytes(target.toPath()));
            File directory = new File(f.root, "directory"); assertTrue(directory.mkdir());
            Files.write(new File(directory, "untracked").toPath(), new byte[]{7});
            try { reopened.remove("directory", reopened.stat("directory")); fail("Must not recursively remove"); }
            catch (IOException expected) { }
            assertTrue(new File(directory, "untracked").isFile());
        }
    }
}
