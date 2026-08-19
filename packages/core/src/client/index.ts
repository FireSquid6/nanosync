import type { Filesystem } from "../filesystem";
import type { FileMap } from "../filemap";
import { FILEMAP_PATH } from "../server/vault";
import { deserializeFileMap, serializeFileMap } from "../filemap";

export class ClientVault {
  private fs: Filesystem;
  constructor(fs: Filesystem) {
    this.fs = fs;
  }

  private async getFileMap(): Promise<FileMap> {
    // ugly, but we have to deal with this for the case where we have big files to stream back
    const data = await new Response(await this.fs.readFile(FILEMAP_PATH)).text();
    const fileMap = deserializeFileMap(data);
    return fileMap;
  }

  private async setFileMap(fileMap: FileMap) {
    const serialized = serializeFileMap(fileMap);
    await this.fs.writeFile(FILEMAP_PATH, serialized);
  }

  async sync() {

  }

  async syncFile() {

  }
}
