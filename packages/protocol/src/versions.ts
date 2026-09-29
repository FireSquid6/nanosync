export const PROTOCOL_VERSION = 1 as const;
export const REVISION_FORMAT_VERSION = 1 as const;
export const OBJECT_FORMAT_VERSION = 1 as const;
export const CRYPTO_FORMAT_VERSION = 1 as const;

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_OBJECT_CIPHERTEXT_BYTES = 64 * 1024 * 1024 * 1024;
export const MAX_REFERENCES_PER_REVISION = 20_000;
export const MAX_PARENTS = 2;
export const MAX_PRESENCE_QUERY = 1_000;
export const MAX_PAGE_SIZE = 1_000;
export const MAX_JSON_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export const OBJECT_FRAME_MAGIC = "NSOBJ001" as const;
export const OBJECT_FRAME_HEADER_BYTES = 80;
export const AES_GCM_TAG_BYTES = 16;
export const RANDOMIZED_NONCE_BYTES = 12;
export const CHUNK_NONCE_BYTES = 0;

export const OBJECT_TYPES = ["chunk", "manifest", "revision-private"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export const OBJECT_TYPE_CODES = {
  chunk: 0x01,
  manifest: 0x02,
  "revision-private": 0x03,
} as const satisfies Record<ObjectType, number>;
