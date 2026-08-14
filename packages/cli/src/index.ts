import { Command } from "@commander-js/extra-typings";
import { serverCommand } from "./server";




const mainCommand = new Command()
  .name("nanosync")
  .description("The simple file manager")

mainCommand
  .addCommand(serverCommand)

mainCommand.parse();
