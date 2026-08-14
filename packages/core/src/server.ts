


export interface NanosyncServerConfig {
  port: number;
}



export function startServer({ port }: NanosyncServerConfig) {
  Bun.serve({
    port,
    routes: {},
  })
}
