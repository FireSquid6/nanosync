import { z } from "zod";
import { parse, stringify } from "yaml";

export const serverConfig = z.object({
  port: z.number(),
  vaults: z.array(vaultConfig),
});

export const vaultConfig = z.object({
  name: z.string(),
  validKeys: z.array(z.string()),
})

export type ServerConfig = z.infer<typeof serverConfig>;


export function serializeServerConfig(config: ServerConfig): string {
  if (!isValidServerConfig(config)) {
    throw new Error("Cannot serialize invalid server config");
  }
  return stringify(config);
}

export function deserializeServerConfig(data: string): ServerConfig {
  let parsed: unknown;
  try {
    parsed = parse(data);
  } catch (error) {
    throw new Error("Failed to parse server config", { cause: error });
  }

  const result = serverConfig.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Failed to deserialize server config: ${z.prettifyError(result.error)}`);
  }
  if (!isValidServerConfig(result.data)) {
    throw new Error("Failed to deserialize server config: invalid port or duplicate vault name");
  }
  return result.data;
}

export function isValidServerConfig(config: unknown): config is ServerConfig {
  const result = serverConfig.safeParse(config);
  if (!result.success) {
    return false;
  }

  const { port, vaults } = result.data;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false;
  }

  const names = new Set(vaults.map((vault) => vault.name));
  return names.size === vaults.length;
}
