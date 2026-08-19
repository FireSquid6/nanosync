import type { Filesystem } from "../filesystem";
import { Vault } from "../vault";


export class ServerVault extends Vault {


  constructor(filesystem: Filesystem) {
    super(filesystem);
  }

}

