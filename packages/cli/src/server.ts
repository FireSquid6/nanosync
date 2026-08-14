import { Command } from "@commander-js/extra-typings";


export const serverCommand = new Command()
  .name("server")
  .description("Subcommand for managing a nanosync server")
