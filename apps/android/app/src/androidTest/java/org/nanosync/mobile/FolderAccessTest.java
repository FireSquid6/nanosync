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
            Files.write(new File(f.root, ".nanosync-control").toPath(), new byte[]{2});
            try { f.access.list(); fail("Partial list must not escape"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void shallowListingDoesNotTraverseIgnoredCandidates() throws Exception {
        try (Fixture f = new Fixture()) {
            File ignored = new File(f.root, "ignored"); assertTrue(ignored.mkdir());
            Files.write(new File(ignored, ".nanosync-control").toPath(), new byte[]{1});
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
