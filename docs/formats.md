# Version 1 Formats and Protocol Contract

This document freezes the version-1 interoperability contract. Protocol, revision, object, and crypto format versions are independent integers and all begin at `1`; an application release number is not a format version.

## Canonical metadata encoding

Protocol metadata is UTF-8 JSON. Values which are hashed or supplied as AEAD associated data are serialized with RFC 8785 JSON Canonicalization Scheme (JCS). Implementations must reject duplicate object member names before or while parsing, arrays where objects are required, inherited or unknown fields, non-safe integers, `NaN`/infinities, invalid Unicode, and noncanonical identifiers. Incoming JSON need not have JCS whitespace or member order unless an endpoint says it is a bound value, but its normalized value must produce one unambiguous JCS encoding.

Large ciphertext is streamed as an HTTP request/response body, not embedded in JSON. JSON metadata requests are at most 8 MiB. Object ciphertext is at most 64 GiB and clients must stream 50 GB files rather than buffer them.

## Identifiers and namespaces

- Vault, device, and revision IDs are lowercase canonical hyphenated UUIDs (36 ASCII characters; RFC 4122 variant, versions 1–8). They are opaque.
- Object IDs and SHA-256 ciphertext checksums are exactly 64 lowercase hexadecimal characters.
- Idempotency keys are 1–128 visible ASCII characters (`0x21`–`0x7e`); spaces and control characters are invalid.
- Object types are `chunk`, `manifest`, and `revision-private`. Storage keys are namespaced as `objects/v1/<type>/<first-two-object-id-characters>/<object-id>`; the type is also authenticated metadata, preventing cross-type substitution.

Chunk IDs are `HMAC-SHA-256(chunk_identifier_key, plaintext_chunk)` and therefore reveal equal chunks within a vault. IDs for randomized encrypted objects are random 256-bit values allocated before encryption. Object IDs are immutable and may never be reused for different bytes or metadata.

## Encrypted object byte format

Files use fixed 4 MiB chunks, recorded as `chunkSize: 4194304` in file metadata. Every non-final chunk is exactly that size; the final chunk is 1 through 4 MiB (an empty file has no chunks). The object record carries object format version, crypto format version, vault ID, object type, object ID, plaintext length, ciphertext length, nonce where randomized, and ciphertext plus GCM tag. SHA-256 covers the complete stored ciphertext envelope bytes.

Object format 1 is exactly one 80-byte header followed by a type-dependent nonce, ciphertext, and a 16-byte GCM tag. There is no padding. Multibyte integers are unsigned big-endian.

| Offset | Width | Field | Version 1 value |
|---:|---:|---|---|
| 0 | 8 | magic | ASCII `NSOBJ001` |
| 8 | 2 | object format | `0x0001` |
| 10 | 2 | crypto format | `0x0001` |
| 12 | 1 | object type | `0x01` chunk, `0x02` manifest, `0x03` revision-private |
| 13 | 1 | nonce length | `0` for chunk; `12` otherwise |
| 14 | 2 | reserved flags | zero; any set bit is invalid |
| 16 | 16 | vault ID | UUID bytes in RFC 4122/network order |
| 32 | 32 | object ID | bytes represented by the 64-hex metadata ID |
| 64 | 8 | plaintext length | exact bytes before AES-GCM |
| 72 | 8 | encrypted payload length | ciphertext bytes excluding nonce and tag |
| 80 | 0 or 12 | nonce | omitted for chunk; physically present otherwise |
| following | encrypted payload length | ciphertext | streamed AES-GCM ciphertext |
| final | 16 | authentication tag | AES-GCM tag |

AES-GCM has no padding, so v1 requires encrypted payload length to equal plaintext length. A chunk frame has no nonce bytes: its nonce is the implied 12 all-zero bytes. Manifest and revision-private frames contain exactly 12 random nonce bytes in the indicated position; an all-zero randomized nonce is syntactically valid but generation must use a CSPRNG. The stored/frame length is exactly `80 + nonceLength + encryptedPayloadLength + 16`. The revision-reference field named `ciphertextLength` means this complete stored frame length, not merely the encrypted-payload field. SHA-256 checksum coverage is every frame byte from magic through the final GCM tag, with no external metadata.

The binary vault UUID must have an RFC 4122 variant and version 1–8 and must equal the request/envelope vault. The 32 object-ID bytes must equal the storage key/reference ID. Object ID is external identity metadata, not a hash of this frame: chunk IDs are the keyed plaintext HMAC; randomized-object IDs are generated as 256 random bits before encryption. Including ID, type, versions, vault, and plaintext length in the exact AAD defined in [security.md](security.md), and requiring header/key equality, binds the frame without a circular ID definition.

The exact v1 object AAD is UTF-8 JCS of the seven-member JSON object `{"cryptoFormatVersion":1,"label":"nanosync/v1/aad/<objectType>","objectFormatVersion":1,"objectId":"<64 lowercase hex>","objectType":"<objectType>","plaintextLength":<positive safe integer>,"vaultId":"<canonical lowercase UUID>"}`; angle-bracketed text denotes substituted values, not literal bytes. For `chunk`, the `objectId` value is the keyed chunk HMAC ID. The ordered member names are normative, including `cryptoFormatVersion` and `objectFormatVersion` rather than abbreviated names. Randomized objects use the same seven names and their respective `manifest` or `revision-private` object type/label. Recovery-wrap AAD is the exact four-member sorted JSON in [security.md](security.md). No frame header or nonce is concatenated to the JCS AAD.

Parsers first read exactly 80 bytes, validate magic, versions, type, flags, IDs, nonce rule, and both lengths using unsigned 64-bit arithmetic, then compute the expected total before allocating or consuming the body. The total frame and advertised `ciphertextLength` must not exceed 64 GiB or the lower negotiated limit. Chunk plaintext is 1–4 MiB; randomized-object plaintext is nonempty and bounded by the remaining frame limit. Lengths above JavaScript's safe-integer range are rejected rather than converted. If HTTP `Content-Length` is present it must equal the computed total before body processing. Implementations stream ciphertext through checksum and AEAD processing, require exactly the computed bytes, reject truncation and any trailing byte, and release no plaintext until the tag authenticates (large randomized plaintext may be authenticated into bounded temporary storage). This preserves 50 GB file support as a sequence of bounded 4 MiB frames; no whole file or 64 GiB object is buffered.

Object format `1` supports:

- chunks encrypted with the deterministic construction in [security.md](security.md);
- randomized encrypted manifests containing names and tree/file records;
- randomized `revision-private` payloads containing private revision data.

The revision carries `referenceSetMac = HMAC-SHA-256(revision_authentication_key, ASCII("nanosync/v1/reference-set-mac") || 0x00 || JCS(envelope_without_referenceSetMac))`. This client-authenticated revision content binds all public fields and exact visible references without the impossible circular dependency created by putting a manifest's own ciphertext checksum inside that manifest. On download, clients must verify it before trusting the envelope or decrypting referenced content. The server cannot verify this binding; an authorized publishing client could lie, which is outside server-side confidentiality enforcement.

### Encrypted manifest plaintext v1

The `manifest` object plaintext is exactly UTF-8 JCS JSON of the following **closed** schema (no BOM, whitespace, duplicate keys, missing/extra members, or alternate versions). The `version` is the independent manifest schema version, exactly `1`. Readers reject noncanonical plaintext bytes, including alternate member/entry ordering. `entries` are sorted by `id` ascending ASCII; `chunks` retain file order. All integer values are JSON safe integers. Example with an empty file:

```json
{"creatingDeviceId":"123e4567-e89b-42d3-a456-426614174002","entries":[{"id":"123e4567-e89b-42d3-a456-426614174003","kind":"directory","name":"","parentId":null},{"chunks":[],"executable":false,"id":"123e4567-e89b-42d3-a456-426614174004","kind":"file","name":"hello.txt","parentId":"123e4567-e89b-42d3-a456-426614174003","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","size":0}],"parents":[],"revisionId":"123e4567-e89b-42d3-a456-426614174001","vaultId":"123e4567-e89b-42d3-a456-426614174000","version":1}
```

Top-level members are exactly `version:1`, `vaultId`, `revisionId`, `parents`, `creatingDeviceId`, `entries`. Identity fields and sorted 0–2 unique parents follow the public envelope UUID/parent rules. Entries number 1–20,000 and contain exactly `id`, `parentId`, `name`, `kind`, plus the kind-specific members below. All entry IDs are unique canonical UUIDs stable across revisions. Exactly one root is a `directory` with `parentId:null` and `name:""`; all other entries have a non-null directory parent in this same manifest. Cycles, orphans, file/tombstone parents, and duplicate sibling names (including Unicode lowercase collisions) are invalid. Sibling name uniqueness includes tombstones. Paths are derived only from this tree; entries do not carry paths.

Names are NFC Unicode strings of 1–255 UTF-8 bytes except root's empty name. Reject invalid Unicode/unpaired surrogates, C0/C1 control characters, DEL, `/`, `\\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, `.` or `..`, trailing dot/space, and Windows reserved basenames `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (case-insensitive, with or without extension). No symlink, device, hard-link, or other special entry kind exists in v1.

- `directory`: no further members except optional `conflict`.
- `file`: exactly `size` (0–50,000,000,000 decimal bytes), `sha256` (64 lowercase hex plaintext SHA-256 of the entire file), `executable` (boolean hint), and `chunks` (ordered array of `{objectId,length}` with no other fields), plus optional `conflict`. `objectId` is a lowercase 64-hex chunk ID. `size:0` requires `chunks:[]` and the SHA-256 of empty bytes. `chunkSize` is fixed to 4,194,304 in v1 and is not serialized: every chunk except the last has exactly that length; the final length is 1–4,194,304; count is `ceil(size/4194304)` (at most 11,921 for a 50 GB file). Identical chunk IDs may recur, but each occurrence must have the same length. The digest is checked when reconstructing file plaintext, not inferred from IDs.
- `tombstone`: exactly `deletedKind:"directory"|"file"` in addition to the four shared members; no content/chunks. Keeps its stable ID. Its former parent/name are retained while representable; if a new live entry takes the name, or a parent directory is deleted, clients may move/rename the tombstone to a unique safe archival location under a surviving directory. The tombstone does not reserve its original path forever and must not be silently resurrected. A deleted directory cannot parent any entry. Tombstones produce no object references.
- Optional `conflict` on live entries is exactly `{sourceEntryId,sourceRevisionId}` (canonical UUIDs); the source entry ID differs from this entry's ID. A conflict copy receives a new ID and retains origin identity for reconciliation. No other metadata is serialized.

Plaintext is 1–4,194,304 bytes. A single 50 GB file's 11,921 chunk descriptors fit within this bound even with unique chunk IDs; manifests with many additional entries may not, and the v1 client rejects them rather than enlarging Web Crypto's one-shot limit. References are exactly the set of distinct live file chunk IDs (with type `chunk` and complete frame `ciphertextLength = chunk length + 96`) plus the single encrypted manifest reference identified by `encryptedManifestObjectId`; no `revision-private`, unrelated manifest, omitted chunk, or extra object is allowed. At most 20,000 public references, including the manifest, are permitted. The manifest never contains its own object ID, ciphertext checksum, or reference list, avoiding a checksum cycle. Publication clients must validate this correspondence after encrypting the manifest and constructing the envelope. Readers first validate the envelope and `referenceSetMac`, then decrypt the manifest via the manifest reference, validate canonical plaintext, compare `vaultId`, `revisionId`, ordered `parents`, and `creatingDeviceId` to the authenticated public envelope, and check exact reference membership/lengths. The server cannot perform these plaintext checks; its existing visible object membership/type/size/equality/reuse leakage remains unchanged.

`envelope_without_referenceSetMac` is the validated v1 revision envelope with *only* that member removed, not a new schema or a JSON string. JCS top-level member order is `createdAt`, `creatingDeviceId`, `encryptedManifestObjectId`, `parents`, `protocolVersion`, `references`, `revisionFormatVersion`, `revisionId`, `vaultId`; each reference's JCS member order is `ciphertextChecksum`, `ciphertextLength`, `objectFormatVersion`, `objectId`, `objectType`. Serialize as UTF-8 without extra whitespace/BOM; retain array order. See [security.md](security.md) for the exact MAC prefix bytes.

## Revision envelope

A revision publication contains:

```text
RevisionEnvelope {
  protocolVersion: 1
  revisionFormatVersion: 1
  vaultId, revisionId
  parents: [one or two sorted unique revision IDs]
  creatingDeviceId
  createdAt: canonical YYYY-MM-DDTHH:mm:ss.sssZ
  encryptedManifestObjectId
  references: sorted unique VisibleObjectReference[1..20000]
  referenceSetMac: 64 lowercase hex HMAC
}
VisibleObjectReference {
  objectId, objectType
  ciphertextChecksum
  ciphertextLength: complete frame length; 97..4194400 for chunks, 109..68719476736 otherwise
  objectFormatVersion: 1
}
```

References are sorted lexically by object ID and IDs are unique across types. The manifest ID must identify a `manifest` entry. The list is the canonical server-visible membership and reachability set: before advancing head the server verifies every entry exists with matching type, length, checksum, and format. It is also the GC traversal source. Consequently the server learns exact per-revision object membership, graph changes, equality, types, sizes, and reuse even though paths and contents remain encrypted. This explicit leakage resolves the impossibility of checking references found only inside an encrypted manifest.

Revision `createdAt` is client-provided display metadata, not trusted server time. Normal revisions have one parent and merge revisions two. Vault initialization is a separately authorized operation which creates the genesis revision; its special zero-parent envelope is not accepted by the ordinary parser/publication endpoint.

## Negotiation and limits

Before upload, clients fetch capabilities containing sorted supported protocol, revision-format, object-format, and object-type lists plus effective limits. V1 constants are: 4 MiB chunks; 64 GiB object ciphertext; 20,000 references/revision; two parents; 1,000 IDs/presence query; 1,000 items/page; 8 MiB JSON metadata; and 128-character idempotency keys. A client must not publish an unadvertised version or type. Servers reject unsupported versions, unknown fields, noncanonical ordering, and values above either the fixed format bound or a lower advertised operational bound.

Readers may retain old format support, but must never reinterpret old bytes under a new version. Adding optional fields requires a new protocol/schema version because v1 rejects unknown fields. Object migration creates new immutable objects; it does not mutate existing IDs.

## Publication and idempotency

`advanceHead` supplies protocol version, vault ID, expected revision ID (nullable only for authorized initialization), proposed envelope, and idempotency key. The server stores the first terminal outcome for the authenticated device, operation, and key. Repeating byte-equivalent normalized input returns `alreadyAccepted` after an earlier success or the recorded failure; reuse with different input is rejected. Records must survive crashes for at least the maximum documented client retry window.

Exact JSON result status spellings are `accepted`/`alreadyAccepted` with revision and positive server sequence, `staleHead` with current revision, `missingObjects` with a sorted bounded ID list, or `invalidRevision` with a stable reason code. Object PUT is independently idempotent: the same ID, length, checksum, type, and bytes succeeds as already present; any mismatch is a conflict. Presence requests contain at most 1,000 IDs. Pages contain at most 1,000 records and use opaque cursors.

Server acceptance occurs in an explicit SQLite `BEGIN IMMEDIATE` transaction after object verification. A crash exposes either the old head or the complete new head and idempotency result, never a partial publication.

The v1 revision HTTP contract is:

- `GET /v1/head` returns `{"protocolVersion":1,"status":"head","revisionId":"...","sequence":N}` for an accepted head (`N` is positive), or `{"protocolVersion":1,"status":"initializedWithoutHead","revisionId":null,"sequence":0}` only during the bootstrap interval.
- `GET /v1/revisions/{revisionId}` returns `{"protocolVersion":1,"revision":RevisionEnvelope,"sequence":N|null}`. A null sequence identifies a prepared stale proposal. Cross-vault IDs are indistinguishable from absent IDs.
- `POST /v1/head/advance` requires `application/json`, the 8 MiB metadata limit, and the strict `AdvanceHeadRequest` shape in this section. Its HTTP status is 200 for every typed `AdvanceHeadResult`; malformed transport/protocol input uses a protocol error envelope.

Exact request and result JSON members (with no additional members) are:

```json
{"protocolVersion":1,"vaultId":"<vault UUID>","expectedRevisionId":"<revision UUID>","proposedRevision":{"protocolVersion":1,"revisionFormatVersion":1,"vaultId":"<vault UUID>","revisionId":"<revision UUID>","parents":["<revision UUID>"],"creatingDeviceId":"<device UUID>","createdAt":"2026-01-02T03:04:05.006Z","encryptedManifestObjectId":"<64 lowercase hex>","references":[{"objectId":"<64 lowercase hex>","objectType":"manifest","ciphertextChecksum":"<64 lowercase hex>","ciphertextLength":109,"objectFormatVersion":1}],"referenceSetMac":"<64 lowercase hex>"},"idempotencyKey":"<visible ASCII>"}
```

```text
{"status":"accepted","revisionId":"<revision UUID>","sequence":N}
{"status":"alreadyAccepted","revisionId":"<revision UUID>","sequence":N}
{"status":"staleHead","currentRevisionId":"<revision UUID>"}
{"status":"missingObjects","objectIds":["<sorted object ID>"]}
{"status":"invalidRevision","reasonCode":"<STABLE_CODE>"}
```

`currentRevisionId` can be null only for the initialized-without-head bootstrap interval. Normal publication never permits a null `expectedRevisionId`.

The advance request digest is SHA-256 over JCS of `{expectedRevisionId,proposedRevision,protocolVersion,vaultId}`: the idempotency key alone is excluded. Idempotency is scoped to authenticated principal and device, operation `advance-head-v1`, and key. Accepted and stale outcomes are terminal and atomically recorded; replay of an accepted result is returned as `alreadyAccepted` with the original revision and sequence. `missingObjects` and `invalidRevision` are not recorded, so repair (notably uploading or restoring objects) may safely retry the same key. Key reuse with a different digest is HTTP 409 `IDEMPOTENCY_KEY_REUSE`.

Normal publication rejects null `expectedRevisionId` as `invalidRevision/GENESIS_REQUIRES_BOOTSTRAP`. One-parent revisions must name the expected revision; sorted two-parent merges must include it. Every parent must already be stored in the vault, including a prepared stale proposal where applicable. Before transaction entry the server checks exact catalog metadata and non-failed integrity state, confirms storage existence in batches of at most 1,000, and confirms stored length. The transaction rechecks exact catalog metadata and integrity before inserting or accepting. A stale structurally valid proposal is retained with a null sequence.

Storage itself cannot participate in the SQLite transaction. The object store is operator-exclusive, and no in-process GC exists in v1; future GC must coordinate with metadata transactions and recheck reachability before deletion. External object mutation is outside this contract. The server stores but cannot verify `referenceSetMac`; clients authenticate it. Server sequence and acceptance order are authoritative, while `createdAt` remains display metadata.

## Protocol errors

General API failures use the strict JSON shape `{ protocolVersion: 1, code, message, retryAfterSeconds? }`; no other fields are allowed. `message` is safe public text of 1–512 UTF-8 bytes without control characters and must never contain secrets, SQL/filesystem details, stack traces, credentials, object plaintext, or internal exception text. `retryAfterSeconds`, when present, is a safe integer from 0 through 86,400.

Stable v1 codes are `MALFORMED_REQUEST`, `UNSUPPORTED_PROTOCOL_VERSION`, `UNSUPPORTED_FORMAT_VERSION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSE`, `BODY_LIMIT_EXCEEDED`, `OBJECT_LIMIT_EXCEEDED`, `REFERENCE_LIMIT_EXCEEDED`, `CHECKSUM_MISMATCH`, `LENGTH_MISMATCH`, `RATE_LIMITED`, `STALE_HEAD`, `MISSING_OBJECTS`, `INVALID_REVISION`, `INTERNAL`, and `UNAVAILABLE`. HTTP status is transport metadata and does not replace this code. Unknown codes or error-envelope fields are rejected by v1 clients. Detailed diagnostics belong only in access-controlled server logs with secret redaction.

## Version 1 object HTTP API

`GET /v1/capabilities` and `GET /v1/health` are public. Health returns only `{"protocolVersion":1,"status":"ok"}` when metadata and object storage are reachable. Protected object and revision routes authenticate a server-wide enrolled device and select an existing vault with `X-Nanosync-Vault-Id: <UUID>`; unknown vaults fail without leaking another vault's data. Legacy single-vault devices without that header retain their original binding. Recovery wraps are likewise selected per vault. New object paths include a vault UUID; legacy objects remain at their original paths. A password-only server with zero vaults cannot serve object operations.

- `POST /v1/objects/presence` accepts `application/json` with the strict shape `{"protocolVersion":1,"objectType":"chunk|manifest|revision-private","objectIds":[...]}`. The list contains 1–1,000 lexically sorted unique IDs. Its operational body limit is 128 KiB. The response is `{"protocolVersion":1,"objectType":...,"objects":[{"objectId":...,"present":boolean},...]}` in request order. A catalog entry with no storage file is marked missing and reported false.
- `PUT /v1/objects/{objectType}/{objectId}` requires exact headers `Content-Length`, `X-Nanosync-Protocol-Version: 1`, `X-Nanosync-Object-Format-Version: 1`, `X-Nanosync-Ciphertext-SHA256` (64 lowercase hex), and `Idempotency-Key`. `Transfer-Encoding` is rejected. The body is one complete object frame whose header identities and computed length match the authenticated vault, route, and headers. Initial success is `{"protocolVersion":1,"status":"stored"}` (201) or `status:"alreadyPresent"` (200). Idempotency is scoped by principal, device, operation, and key. The request digest binds normalized vault/type/ID/length/checksum/version metadata. A same-request terminal-success replay returns HTTP 200 with the persisted JSON body; the original HTTP status is not persisted. Key reuse with different metadata is `IDEMPOTENCY_KEY_REUSE`. Failures are not recorded. A crash after durable object publication but before catalog/idempotency commit is repaired by retry. After storage has accepted or checksum-verified an exact matching object, the catalog transaction resets prior `missing` or `corrupt` integrity state to `unchecked`; storage conflicts never clear integrity failures. A completed idempotency replay may cancel the unneeded body after request-header validation, and an already-present immutable object may cancel the remaining body after fixed-header validation. Clients must not rely on complete consumption of duplicate upload bodies.
- `GET /v1/objects/{objectType}/{objectId}` first requires an exact catalog type/ID match and then streams `application/octet-stream`. It returns `Content-Length`, `Accept-Ranges: bytes`, `X-Nanosync-Object-Type`, and the protocol/object-format/checksum headers used above. Exactly one RFC byte range is supported: closed (`bytes=0-9`), open-ended (`bytes=10-`), or suffix (`bytes=-10`). HTTP endpoints are inclusive and storage ranges are half-open. A valid range returns 206 and `Content-Range`; malformed, multiple, or unsatisfiable ranges return 416 plus `Content-Range: bytes */size` and a protocol error envelope. A cataloged object missing from storage, or whose stored length disagrees with the catalog, is marked with the corresponding integrity failure and returns 503 `UNAVAILABLE`; only an absent catalog entry returns 404.

Unknown paths return `NOT_FOUND`; unsupported methods return 405 with a protocol error envelope and `Allow`. JSON responses use `application/json; charset=utf-8`. Protected-route authorization failures are always `UNAUTHORIZED`. Unexpected failures expose only generic `INTERNAL` messages.

## Version 1 authentication and device API

Bearer/password-session tokens are exactly 32 random bytes encoded as canonical unpadded base64url (43 characters). Authorization accepts exactly one `Authorization: Bearer <token>` value with that spelling and one ASCII space; cookies, query parameters, forwarding headers, alternate schemes, padding, and combined/duplicate values are rejected. The pepper-HMAC input is ASCII `nanosync/v1/bearer-token`, one NUL byte, then decoded token bytes. This common digest representation permits transactional session-to-credential promotion.

- `POST /v1/auth/password`: strict JSON `{"protocolVersion":1,"password":"<1..1024 UTF-8 bytes>"}`. Success is `{"protocolVersion":1,"status":"authenticated","sessionToken":"<token>","expiresAtMs":N}` with `Cache-Control: no-store`.
- `POST /v1/auth/enrollments`: password-session bearer plus strict JSON `{"protocolVersion":1,"deviceId":"<UUID>","displayName":"<1..128 UTF-8 bytes>","platform":"<1..32 UTF-8 bytes>","clientVersion":"<1..64 UTF-8 bytes>","fingerprint":"<32-byte base64url>"}`. Metadata rejects controls. Result is `{"protocolVersion":1,"status":"pending|approved","deviceId":"<UUID>"}`. Exact retries are idempotent; changed bindings conflict.
- `GET /v1/auth/enrollments/status`: a valid enrollment token receives `{"protocolVersion":1,"status":"pending|approved|denied|expired","deviceId":"<UUID>"}`. Before approval it cannot access protected data/admin/recovery routes. Once approved the same token is the durable credential.
- `GET /v1/admin/enrollments` lists pending metadata for active administrators. `POST /v1/admin/enrollments/{deviceId}/approve` requires exactly `{"protocolVersion":1}`; approval retries are safe.
- `GET /v1/admin/devices` lists safe device metadata/state. `POST /v1/admin/devices/{deviceId}/revoke` requires exactly `{"protocolVersion":1}`. Self and last-active-administrator revocation are forbidden.
- `GET /v1/recovery-wrap` returns `{"protocolVersion":1,"recoveryWrap":RecoveryWrapV1}` only to active approved credentials, with `Cache-Control: no-store`. No recovery-secret, plaintext-key, unwrapping, or key-validation endpoint exists.

New vault lifecycle endpoints authenticate approved server-wide devices: `GET /v1/vaults` lists vault UUID/name/sequence, `POST /v1/vaults` accepts a unique name, new UUID, client-generated recovery wrap, encrypted empty-genesis manifest frame and matching revision, and `POST /v1/vaults/{vaultId}/rename` changes the case-insensitively unique display name without changing the UUID. Creation retries with the same UUID/name/genesis are idempotent. No remote deletion endpoint exists. Every approved device may create and access any vault, but a recovery secret or stored key is still necessary to decrypt it.

Authentication JSON bodies are limited to 2 KiB (device action bodies to 128 bytes), require `application/json`, and use duplicate-key-aware parsing. Public output never includes verifier parameters, salts, hashes, credential digests, audit internals, passwords, pepper, or repository errors.

The first enrollment for the exact designated bootstrap device additionally requires `X-Nanosync-Bootstrap-Authorization`. Its value is 1–1,024 visible ASCII characters, cannot contain comma, and is authorization material rather than JSON metadata. The normal `Authorization` header remains exclusively `Bearer <password-session-token>`. Before calling the injected bootstrap authorizer, the server removes that bearer header from the authorization request, so accepting the password session cannot accidentally accept the bootstrap handoff. Missing dependencies, malformed/duplicate handoff values, false results, and authorizer exceptions fail with generic `UNAUTHORIZED`. Successful initial activation atomically verifies the persisted initial UUID, pending administrator state, empty credential, session binding, and handoff result. No ordinary administrator approval or re-enrollment path can promote the initial identity. An exact retry from the same promoted session is idempotent without a second handoff; a new password session cannot use that exception.

## Legacy single-vault bootstrap protocol

Bootstrap is a separately authorized, one-time **legacy** bridge to the normal object and revision invariants. New deployments use local password-only `server init` followed by device enrollment and separate vault creation. `GET /v1/bootstrap/status` is public and returns `{"protocolVersion":1,"status":"uninitialized|initializedWithoutHead|sealed"}`; it reveals no identifiers or secret material. Mutation routes require an explicitly injected bootstrap authorizer and never infer trust from a network address or header.

`POST /v1/bootstrap/initialize` accepts strict JSON (8 MiB transport limit, although the shape is small):

```json
{"protocolVersion":1,"principalId":"<UUID>","vaultId":"<UUID>","initialDeviceId":"<UUID>","password":"<1..1024 UTF-8 bytes>","recoveryWrap":{"version":1,"algorithm":"A256GCM","nonce":"<12 bytes base64url>","ciphertext":"<48 bytes base64url>"}}
```

Both binary fields use canonical unpadded RFC 4648 base64url: alternate alphabets, padding, nonzero discarded bits, and wrong lengths are rejected. The client creates the wrap using the AAD in `security.md`. The server validates only this wire shape and stores the wrap opaquely; it cannot unwrap it, prove that it contains a vault key, or validate the recovery secret. Initialization atomically creates the sole account, singleton vault with sequence zero/no head, designated initial device identity (not a credential), immutable recovery wrap, and lifecycle row. Success is `201 {"protocolVersion":1,"status":"initializedWithoutHead"}`. Concurrent or later initialization gets `409 CONFLICT`. A failed transaction leaves the server uninitialized.

While and only while status is `initializedWithoutHead`, `PUT /v1/bootstrap/objects/{objectType}/{objectId}` applies the exact normal object PUT headers, streaming frame parser, checksum, length, storage, catalog, and idempotency rules. It uses the persisted principal/initial-device/vault binding solely as bootstrap operation identity. It does not issue a bearer credential. This is the only bootstrap object route: other methods on that exact path return 405 with `Allow: PUT`; presence, collection, download, and extra-segment routes are absent and return 404.

`POST /v1/bootstrap/complete` accepts exactly `{"protocolVersion":1,"vaultId":"<UUID>","genesisRevision":RevisionEnvelope}` where the envelope is the persisted-envelope shape except that `parents` must be exactly `[]`. The vault and creating device must equal the initialized singleton binding. References remain sorted, unique, and bounded; the encrypted manifest must identify a manifest reference. Before its transaction the server checks exact catalog metadata, integrity state, durable existence in batches of at most 1,000, and size with at most 32 concurrent stats. Missing/size-mismatched objects produce `{"protocolVersion":1,"status":"missingObjects","objectIds":[...]}` and remain retryable. The transaction rechecks exact catalog metadata/integrity, inserts the immutable revision and references, assigns accepted sequence 1, moves the head to sequence 1, and seals bootstrap. Success is `{"protocolVersion":1,"status":"accepted","revisionId":"<UUID>","sequence":1}`. SQL failure rolls the entire group back. Concurrent completion has one winner; the loser receives `409 CONFLICT`. Once sealed, bootstrap object upload and completion are permanently rejected with `403 FORBIDDEN`, while another initialize request remains a `409 CONFLICT`. Ordinary `/v1/head/advance` continues to reject zero-parent genesis.
