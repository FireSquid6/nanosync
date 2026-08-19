import { z } from "zod"; 


export const fileMapData = z.object({
  hash: z.string(),
  lastEdited: z.iso.datetime(), 
  deleted: z.boolean(),
});

export type FileMapData = z.infer<typeof fileMapData>;
export type FileMap = Record<string, FileMapData>;

export function deserializeFileMap(data: string): FileMap {
  const obj: unknown = JSON.parse(data);
  const parsed = z.safeParse(z.record(z.string(), fileMapData), obj);

  if (!parsed.success) {
    throw new Error(`Failed to deserialize file map: ${JSON.stringify(z.treeifyError(parsed.error).errors)}`);
  }

  return parsed.data;
}

export function serializeFileMap(map: FileMap): string {
  return JSON.stringify(map);
}
