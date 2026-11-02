package org.nanosync.mobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** Local-only system file-browser integration. No network or vault key is used here. */
public final class VaultDocumentsProvider extends DocumentsProvider {
    private static final String TAG = "NanosyncDocuments";
    private static final String AUTHORITY = "org.nanosync.mobile.documents";
    private static final String ROOT = "vault";
    private static final String[] ROOT_COLUMNS = {
        DocumentsContract.Root.COLUMN_ROOT_ID, DocumentsContract.Root.COLUMN_DOCUMENT_ID,
        DocumentsContract.Root.COLUMN_TITLE, DocumentsContract.Root.COLUMN_FLAGS,
        DocumentsContract.Root.COLUMN_MIME_TYPES, DocumentsContract.Root.COLUMN_AVAILABLE_BYTES
    };
    private static final String[] DOC_COLUMNS = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_FLAGS
    };

    private Index index;
    private File bodies;
    private final Set<String> writers = new HashSet<>();

    @Override public boolean onCreate() {
        index = new Index(getContext());
        bodies = new File(getContext().getFilesDir(), "vault-bodies");
        return bodies.isDirectory() || bodies.mkdirs();
    }

    private static String[] columns(String[] requested, String[] defaults) {
        return requested == null ? defaults : requested;
    }

    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor result = new MatrixCursor(columns(projection, ROOT_COLUMNS));
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(DocumentsContract.Root.COLUMN_ROOT_ID, ROOT);
        row.add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, ROOT);
        row.add(DocumentsContract.Root.COLUMN_TITLE, "Nanosync");
        row.add(DocumentsContract.Root.COLUMN_FLAGS, DocumentsContract.Root.FLAG_SUPPORTS_CREATE);
        row.add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*");
        row.add(DocumentsContract.Root.COLUMN_AVAILABLE_BYTES, bodies.getUsableSpace());
        return result;
    }

    @Override public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor result = new MatrixCursor(columns(projection, DOC_COLUMNS));
        addDocument(result, documentId);
        return result;
    }

    @Override public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder)
            throws FileNotFoundException {
        if (!index.isDirectory(parentDocumentId)) throw new FileNotFoundException(parentDocumentId);
        MatrixCursor result = new MatrixCursor(columns(projection, DOC_COLUMNS));
        try (Cursor children = index.db().query("documents", new String[]{"id"}, "parent=?",
                new String[]{parentDocumentId}, null, null, "name COLLATE NOCASE")) {
            while (children.moveToNext()) addDocument(result, children.getString(0));
        }
        result.setNotificationUri(getContext().getContentResolver(),
                DocumentsContract.buildChildDocumentsUri(AUTHORITY, parentDocumentId));
        return result;
    }

    private void addDocument(MatrixCursor result, String id) throws FileNotFoundException {
        if (ROOT.equals(id)) {
            MatrixCursor.RowBuilder row = result.newRow();
            row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, ROOT);
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, "Nanosync");
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR);
            row.add(DocumentsContract.Document.COLUMN_SIZE, 0);
            row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, 0);
            row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE);
            return;
        }
        try (Cursor c = index.db().query("documents", new String[]{"name", "mime", "size", "modified"},
                "id=?", new String[]{id}, null, null, null)) {
            if (!c.moveToFirst()) throw new FileNotFoundException(id);
            boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1));
            MatrixCursor.RowBuilder row = result.newRow();
            row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, id);
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, c.getString(0));
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, c.getString(1));
            row.add(DocumentsContract.Document.COLUMN_SIZE, c.getLong(2));
            row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, c.getLong(3));
            row.add(DocumentsContract.Document.COLUMN_FLAGS, directory
                ? DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE | DocumentsContract.Document.FLAG_SUPPORTS_DELETE
                    | DocumentsContract.Document.FLAG_SUPPORTS_RENAME
                : DocumentsContract.Document.FLAG_SUPPORTS_WRITE | DocumentsContract.Document.FLAG_SUPPORTS_DELETE
                    | DocumentsContract.Document.FLAG_SUPPORTS_RENAME);
        }
    }

    private static void checkName(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..")
                || name.length() > 255 || name.endsWith(".") || name.endsWith(" ")
                || name.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?$")) {
            throw new IllegalArgumentException("Invalid vault name");
        }
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (Character.isSurrogate(c)) {
                if (!Character.isHighSurrogate(c) || i + 1 == name.length()
                        || !Character.isLowSurrogate(name.charAt(++i))) {
                    throw new IllegalArgumentException("Invalid vault name");
                }
                continue;
            }
            if (c < 32 || c == 127 || c == '/' || c == '\\' || ":*?\"<>|".indexOf(c) >= 0) {
                throw new IllegalArgumentException("Invalid vault name");
            }
        }
        if (!java.text.Normalizer.isNormalized(name, java.text.Normalizer.Form.NFC)
                || name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 255) {
            throw new IllegalArgumentException("Invalid vault name");
        }
    }

    private void changed(String id, String kind) {
        ContentValues event = new ContentValues();
        event.put("id", id);
        event.put("kind", kind);
        index.db().insertOrThrow("changes", null, event);
    }

    private void notifyChildren(String parent) {
        ContentResolver resolver = getContext().getContentResolver();
        resolver.notifyChange(DocumentsContract.buildChildDocumentsUri(AUTHORITY, parent), null);
    }

    private void requireFreeName(String parent, String name, String exceptId) {
        try (Cursor siblings = index.db().query("documents", new String[]{"id", "name"},
                "parent=?", new String[]{parent}, null, null, null)) {
            while (siblings.moveToNext()) {
                if (!siblings.getString(0).equals(exceptId) &&
                        siblings.getString(1).toLowerCase(Locale.ROOT).equals(name.toLowerCase(Locale.ROOT))) {
                    throw new IllegalArgumentException("Vault name already exists");
                }
            }
        }
    }

    @Override public synchronized String createDocument(String parentId, String mime, String displayName)
            throws FileNotFoundException {
        if (!index.isDirectory(parentId)) throw new FileNotFoundException(parentId);
        checkName(displayName);
        requireFreeName(parentId, displayName, "");
        if (mime == null || mime.isEmpty() || (!DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)
                && !mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+"))) {
            throw new IllegalArgumentException("Invalid MIME type");
        }
        String id = UUID.randomUUID().toString();
        SQLiteDatabase db = index.db();
        db.beginTransaction();
        boolean createdBody = false;
        try {
            ContentValues document = new ContentValues();
            document.put("id", id);
            document.put("parent", parentId);
            document.put("name", displayName);
            document.put("mime", mime);
            document.put("size", 0);
            document.put("modified", System.currentTimeMillis());
            db.insertOrThrow("documents", null, document);
            if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                try {
                    if (!new File(bodies, id).createNewFile()) throw new IOException("Body already exists");
                    createdBody = true;
                } catch (IOException e) {
                    throw new IllegalStateException("Cannot create document body", e);
                }
            }
            changed(id, "create");
            db.setTransactionSuccessful();
        } catch (RuntimeException e) {
            if (createdBody) new File(bodies, id).delete();
            throw e;
        } finally {
            db.endTransaction();
        }
        notifyChildren(parentId);
        return id;
    }

    @Override public synchronized String renameDocument(String documentId, String displayName)
            throws FileNotFoundException {
        if (ROOT.equals(documentId)) throw new FileNotFoundException(documentId);
        checkName(displayName);
        String parent = index.parent(documentId);
        requireFreeName(parent, displayName, documentId);
        ContentValues values = new ContentValues();
        values.put("name", displayName);
        values.put("modified", System.currentTimeMillis());
        SQLiteDatabase db = index.db();
        db.beginTransaction();
        try {
            db.update("documents", values, "id=?", new String[]{documentId});
            changed(documentId, "rename");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        notifyChildren(parent);
        return documentId;
    }

    @Override public synchronized void deleteDocument(String documentId) throws FileNotFoundException {
        if (ROOT.equals(documentId) || writers.contains(documentId)) throw new FileNotFoundException(documentId);
        String parent = index.parent(documentId);
        ArrayList<String> descendants = new ArrayList<>();
        collectDescendants(documentId, descendants);
        for (String id : descendants) if (writers.contains(id)) throw new FileNotFoundException("Document is open for writing");
        SQLiteDatabase db = index.db();
        db.beginTransaction();
        try {
            changed(documentId, "delete");
            for (int i = descendants.size() - 1; i >= 0; i--) {
                db.delete("documents", "id=?", new String[]{descendants.get(i)});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        for (String id : descendants) {
            if (!new File(bodies, id).delete() && new File(bodies, id).exists()) {
                Log.w(TAG, "Orphaned body " + id);
            }
        }
        notifyChildren(parent);
    }

    private void collectDescendants(String id, ArrayList<String> ids) {
        ids.add(id);
        try (Cursor children = index.db().query("documents", new String[]{"id"}, "parent=?",
                new String[]{id}, null, null, null)) {
            while (children.moveToNext()) collectDescendants(children.getString(0), ids);
        }
    }

    @Override public synchronized ParcelFileDescriptor openDocument(String documentId, String mode,
            CancellationSignal signal) throws FileNotFoundException {
        if (index.isDirectory(documentId)) throw new FileNotFoundException(documentId);
        index.parent(documentId);
        File body = new File(bodies, documentId);
        if (!body.isFile()) throw new FileNotFoundException(documentId);
        if ("r".equals(mode)) return ParcelFileDescriptor.open(body, ParcelFileDescriptor.MODE_READ_ONLY);
        if (!"w".equals(mode) && !"wt".equals(mode) && !"wa".equals(mode)
                && !"rw".equals(mode) && !"rwt".equals(mode)) {
            throw new FileNotFoundException("Unsupported mode");
        }
        if (!writers.add(documentId)) throw new FileNotFoundException("Document already open for writing");
        File stage = new File(bodies, UUID.randomUUID() + ".stage");
        try {
            if ("rw".equals(mode) || "wa".equals(mode)) {
                Files.copy(body.toPath(), stage.toPath());
            } else if (!stage.createNewFile()) {
                throw new IOException("Stage already exists");
            }
            int flags = "rw".equals(mode) ? ParcelFileDescriptor.MODE_READ_WRITE
                : "wa".equals(mode) ? ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_APPEND
                : "rwt".equals(mode) ? ParcelFileDescriptor.MODE_READ_WRITE : ParcelFileDescriptor.MODE_WRITE_ONLY;
            return ParcelFileDescriptor.open(stage, flags, new Handler(Looper.getMainLooper()), error -> {
                synchronized (VaultDocumentsProvider.this) {
                    try {
                        if (error == null && index.exists(documentId)) {
                            try (FileOutputStream flush = new FileOutputStream(stage, true)) {
                                flush.getFD().sync();
                            }
                            Files.move(stage.toPath(), body.toPath(), StandardCopyOption.ATOMIC_MOVE,
                                StandardCopyOption.REPLACE_EXISTING);
                            ContentValues values = new ContentValues();
                            values.put("size", body.length());
                            values.put("modified", System.currentTimeMillis());
                            SQLiteDatabase db = index.db();
                            db.beginTransaction();
                            try {
                                db.update("documents", values, "id=?", new String[]{documentId});
                                changed(documentId, "write");
                                db.setTransactionSuccessful();
                            } finally {
                                db.endTransaction();
                            }
                            getContext().getContentResolver().notifyChange(
                                DocumentsContract.buildDocumentUri(AUTHORITY, documentId), null);
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to commit document write: " + documentId, e);
                    } finally {
                        stage.delete();
                        writers.remove(documentId);
                    }
                }
            });
        } catch (IOException | RuntimeException e) {
            stage.delete();
            writers.remove(documentId);
            FileNotFoundException failure = new FileNotFoundException("Cannot stage write: " + documentId);
            failure.initCause(e);
            throw failure;
        }
    }

    @Override public boolean isChildDocument(String parentDocumentId, String documentId) {
        try {
            Set<String> visited = new HashSet<>();
            String current = documentId;
            while (!ROOT.equals(current) && visited.add(current)) {
                current = index.parent(current);
                if (parentDocumentId.equals(current)) return true;
            }
        } catch (FileNotFoundException ignored) {
            // Unknown IDs are never children.
        }
        return false;
    }

    private static final class Index extends SQLiteOpenHelper {
        Index(Context context) { super(context, "vault-documents.db", null, 1); }

        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE documents (id TEXT PRIMARY KEY, parent TEXT NOT NULL, "
                + "name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL, "
                + "UNIQUE(parent, name))");
            db.execSQL("CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, kind TEXT NOT NULL)");
            db.execSQL("CREATE INDEX document_parent ON documents(parent)");
        }

        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new IllegalStateException("No vault database migration defined");
        }

        boolean exists(String id) {
            try (Cursor c = db().query("documents", new String[]{"id"}, "id=?",
                    new String[]{id}, null, null, null)) {
                return c.moveToFirst();
            }
        }

        String parent(String id) throws FileNotFoundException {
            try (Cursor c = db().query("documents", new String[]{"parent"}, "id=?",
                    new String[]{id}, null, null, null)) {
                if (!c.moveToFirst()) throw new FileNotFoundException(id);
                return c.getString(0);
            }
        }

        boolean isDirectory(String id) {
            if (ROOT.equals(id)) return true;
            try (Cursor c = db().query("documents", new String[]{"mime"}, "id=?",
                    new String[]{id}, null, null, null)) {
                return c.moveToFirst() && DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(0));
            }
        }

        SQLiteDatabase db() { return getWritableDatabase(); }
    }
}
